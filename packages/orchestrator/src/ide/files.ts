import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { HttpError, MAX_FILE, cleanRel, isInside, isSecretName, languageOf, looksBinary, resolveInside } from "./paths.js";

export interface Entry { name: string; path: string; type: "dir" | "file" | "symlink" | "submodule"; size?: number; outside?: boolean; secret?: boolean }
export interface FileView { path: string; size: number; language: string; sha256?: string; content?: string; binary?: boolean; too_large?: boolean; masked?: boolean }

const HIDDEN = new Set([".git"]);
const MAX_ENTRIES = 5000;
const sortEntries = (a: Entry, b: Entry) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name);

/** Run git and return raw bytes (no shell, argv only). */
export function gitBuf(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "buffer", maxBuffer, timeout: 30_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (e, out, err) => {
      const code = e ? (typeof (e as { code?: unknown }).code === "number" ? (e as unknown as { code: number }).code : 1) : 0;
      resolve({ code, out: out as Buffer, err: String(err) });
    });
  });
}

export async function gitText(cwd: string, args: string[]): Promise<string> {
  const r = await gitBuf(cwd, args);
  if (r.code !== 0) throw new HttpError(400, `git ${args[0]}: ${r.err.trim().slice(0, 300)}`);
  return r.out.toString("utf8");
}

/** A ref the client may name: branch/tag/sha style only, never an option. */
export async function verifyRef(cwd: string, ref: unknown): Promise<string> {
  if (typeof ref !== "string" || !/^[A-Za-z0-9._/@{}~^-]{1,200}$/.test(ref) || ref.startsWith("-") || ref.includes("..")) throw new HttpError(400, "bad ref");
  const r = await gitBuf(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (r.code !== 0) throw new HttpError(404, `unknown ref ${ref}`);
  return r.out.toString().trim();
}

function view(rel: string, buf: Buffer, size: number, reveal: boolean): FileView {
  const base: FileView = { path: rel, size, language: languageOf(rel) };
  if (size > MAX_FILE) return { ...base, too_large: true };
  if (isSecretName(rel) && !reveal) return { ...base, masked: true };
  if (looksBinary(buf)) return { ...base, binary: true, sha256: sha(buf) };
  return { ...base, sha256: sha(buf), content: buf.toString("utf8") };
}
export const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** Files on disk under a workspace root. */
export const disk = {
  tree(root: string, rel: unknown): Entry[] {
    const { abs, rel: r } = resolveInside(root, rel);
    if (!statSync(abs).isDirectory()) throw new HttpError(400, "not a directory");
    const realRoot = realpathSync(root);
    const out: Entry[] = [];
    for (const d of readdirSync(abs, { withFileTypes: true }).slice(0, MAX_ENTRIES)) {
      if (HIDDEN.has(d.name)) continue;
      const p = r ? `${r}/${d.name}` : d.name;
      const full = path.join(abs, d.name);
      if (d.isSymbolicLink()) {
        let inside = false, isDir = false;
        try {
          const t = realpathSync(full);
          inside = isInside(realRoot, t);
          isDir = statSync(t).isDirectory();
        } catch { /* dangling */ }
        out.push(inside ? { name: d.name, path: p, type: isDir ? "dir" : "file" } : { name: d.name, path: p, type: "symlink", outside: true });
      } else if (d.isDirectory()) out.push({ name: d.name, path: p, type: "dir" });
      else if (d.isFile()) out.push({ name: d.name, path: p, type: "file", size: lstatSync(full).size, secret: isSecretName(d.name) || undefined });
    }
    return out.sort(sortEntries);
  },
  file(root: string, rel: unknown, reveal = false): FileView {
    const { abs, rel: r } = resolveInside(root, rel);
    const st = statSync(abs);
    if (!st.isFile()) throw new HttpError(400, "not a file");
    if (st.size > MAX_FILE) return { path: r, size: st.size, language: languageOf(r), too_large: true };
    return view(r, readFileSync(abs), st.size, reveal);
  },
};

/** Files at a git commit (any ref), read from the object database; nothing is checked out. */
export const atRef = {
  async tree(cwd: string, ref: string, rel: unknown): Promise<Entry[]> {
    const r = cleanRel(rel);
    const out = await gitBuf(cwd, ["ls-tree", "-z", "-l", r ? `${ref}:${r}` : ref]);
    if (out.code !== 0) throw new HttpError(404, "not a directory at that ref");
    const entries: Entry[] = [];
    for (const rec of out.out.toString("utf8").split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      const [mode, type, , size] = rec.slice(0, tab).split(/\s+/);
      const name = rec.slice(tab + 1);
      const p = r ? `${r}/${name}` : name;
      if (type === "tree") entries.push({ name, path: p, type: "dir" });
      else if (type === "commit") entries.push({ name, path: p, type: "submodule" });
      else if (mode === "120000") entries.push({ name, path: p, type: "symlink" });
      else entries.push({ name, path: p, type: "file", size: Number(size), secret: isSecretName(name) || undefined });
      if (entries.length >= MAX_ENTRIES) break;
    }
    return entries.sort(sortEntries);
  },
  async file(cwd: string, ref: string, rel: unknown, reveal = false): Promise<FileView> {
    const r = cleanRel(rel);
    if (!r) throw new HttpError(400, "not a file");
    const spec = `${ref}:${r}`;
    const t = await gitBuf(cwd, ["cat-file", "-t", spec]);
    if (t.code !== 0 || t.out.toString().trim() !== "blob") throw new HttpError(404, "not found at that ref");
    const size = Number((await gitText(cwd, ["cat-file", "-s", spec])).trim());
    if (size > MAX_FILE) return { path: r, size, language: languageOf(r), too_large: true };
    const b = await gitBuf(cwd, ["cat-file", "blob", spec]);
    return view(r, b.out, size, reveal);
  },
};
