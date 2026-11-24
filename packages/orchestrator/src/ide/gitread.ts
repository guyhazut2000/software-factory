import { readFileSync, statSync } from "node:fs";
import { gitBuf, gitText, sha, verifyRef } from "./files.js";
import { HttpError, MAX_FILE, cleanRel, isSecretName, languageOf, looksBinary, resolveInside } from "./paths.js";

export interface Change { path: string; orig_path?: string; staged: string; unstaged: string; untracked?: boolean; conflict?: boolean }
export interface Status { branch: string | null; detached: boolean; upstream: string | null; ahead: number; behind: number; changes: Change[]; truncated: boolean }

const MAX_CHANGES = 2000;

/** `git status --porcelain=v2 -z --branch`, parsed. X/Y use git's letters (M, A, D, R, C, T, U), '.' = unchanged. */
export async function status(root: string): Promise<Status> {
  const out = await gitText(root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
  const recs = out.split("\0");
  const st: Status = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, changes: [], truncated: false };
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.startsWith("# branch.head ")) {
      const h = r.slice(14);
      st.detached = h === "(detached)";
      st.branch = st.detached ? null : h;
    } else if (r.startsWith("# branch.upstream ")) st.upstream = r.slice(18);
    else if (r.startsWith("# branch.ab ")) {
      const [a, b] = r.slice(12).split(" ");
      st.ahead = Number(a);
      st.behind = -Number(b);
    } else if (st.changes.length >= MAX_CHANGES) st.truncated = true;
    else if (r[0] === "1") {
      const f = r.split(" ");
      st.changes.push({ path: f.slice(8).join(" "), staged: f[1][0], unstaged: f[1][1] });
    } else if (r[0] === "2") {
      const f = r.split(" ");
      st.changes.push({ path: f.slice(9).join(" "), orig_path: recs[++i], staged: f[1][0], unstaged: f[1][1] });
    } else if (r[0] === "u") {
      const f = r.split(" ");
      st.changes.push({ path: f.slice(10).join(" "), staged: "U", unstaged: "U", conflict: true });
    } else if (r[0] === "?") st.changes.push({ path: r.slice(2), staged: ".", unstaged: "?", untracked: true });
  }
  return st;
}

/** One side of a diff: a commit, the index, or the working tree on disk. */
export type Side = { kind: "ref"; sha: string } | { kind: "index" } | { kind: "worktree" };
export interface Blob { exists: boolean; content?: string; binary?: boolean; too_large?: boolean; masked?: boolean; size?: number; sha256?: string }

async function readSide(root: string, side: Side, rel: string, reveal: boolean): Promise<Blob> {
  let buf: Buffer;
  if (side.kind === "worktree") {
    let abs: string;
    try {
      abs = resolveInside(root, rel).abs;
    } catch (e) {
      if ((e as HttpError).status === 404) return { exists: false };
      throw e;
    }
    const size = statSync(abs).size;
    if (size > MAX_FILE) return { exists: true, too_large: true, size };
    buf = readFileSync(abs);
  } else {
    const spec = side.kind === "index" ? `:${rel}` : `${side.sha}:${rel}`;
    const s = await gitBuf(root, ["cat-file", "-s", spec]);
    if (s.code !== 0) return { exists: false };
    const size = Number(s.out.toString().trim());
    if (size > MAX_FILE) return { exists: true, too_large: true, size };
    buf = (await gitBuf(root, ["cat-file", "blob", spec])).out;
  }
  if (isSecretName(rel) && !reveal) return { exists: true, masked: true, size: buf.length };
  if (looksBinary(buf)) return { exists: true, binary: true, size: buf.length, sha256: sha(buf) };
  return { exists: true, content: buf.toString("utf8"), size: buf.length, sha256: sha(buf) };
}

export interface DiffFile { path: string; orig_path?: string; status: string }
export interface DiffSpec { a: Side; b: Side; label: string }

/** Resolve a diff request into two sides. `range` compares merge-base(base, head) with head (GitHub PR semantics). */
export async function diffSpec(root: string, q: { mode: string; base?: string | null; head?: string | null; worktree?: boolean }): Promise<DiffSpec> {
  if (q.mode === "unstaged") return { a: { kind: "index" }, b: { kind: "worktree" }, label: "Working tree vs index" };
  if (q.mode === "staged") {
    const head = await gitBuf(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const a: Side = head.code === 0 ? { kind: "ref", sha: head.out.toString().trim() } : { kind: "ref", sha: EMPTY_TREE };
    return { a, b: { kind: "index" }, label: "Index vs HEAD" };
  }
  if (q.mode === "range") {
    if (!q.base) throw new HttpError(400, "base required");
    const base = await verifyRef(root, q.base);
    const b: Side = q.head ? { kind: "ref", sha: await verifyRef(root, q.head) } : q.worktree ? { kind: "worktree" } : { kind: "ref", sha: await verifyRef(root, "HEAD") };
    const mb = await gitBuf(root, ["merge-base", base, b.kind === "ref" ? b.sha : "HEAD"]);
    const a: Side = { kind: "ref", sha: mb.code === 0 ? mb.out.toString().trim() : base };
    return { a, b, label: `${q.base}...${q.head ?? (q.worktree ? "working tree" : "HEAD")}` };
  }
  throw new HttpError(400, "mode must be unstaged, staged or range");
}
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Changed files between the two sides (renames detected; untracked files included when b is the working tree). */
export async function diffFiles(root: string, d: DiffSpec): Promise<{ files: DiffFile[]; truncated: boolean }> {
  const args = ["diff", "--name-status", "-z", "-M", "--no-color", "--no-ext-diff"];
  if (d.a.kind === "index" && d.b.kind === "worktree") { /* default */ }
  else if (d.b.kind === "index") args.push("--cached", (d.a as { sha: string }).sha);
  else if (d.b.kind === "worktree") args.push((d.a as { sha: string }).sha);
  else args.push((d.a as { sha: string }).sha, d.b.sha);
  const recs = (await gitText(root, [...args, "--"])).split("\0");
  const files: DiffFile[] = [];
  for (let i = 0; i < recs.length - 1; ) {
    const code = recs[i++];
    if (!code) continue;
    if (code[0] === "R" || code[0] === "C") files.push({ status: code[0], orig_path: recs[i++], path: recs[i++] });
    else files.push({ status: code[0], path: recs[i++] });
  }
  if (d.b.kind === "worktree") {
    const un = (await gitText(root, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
    for (const p of un) files.push({ status: "?", path: p });
  }
  return { files: files.slice(0, MAX_CHANGES), truncated: files.length > MAX_CHANGES };
}

/** Both sides of one file, ready for the Monaco diff editor. */
export async function diffPair(root: string, d: DiffSpec, relRaw: unknown, origRaw: unknown, reveal: boolean) {
  const rel = cleanRel(relRaw);
  if (!rel) throw new HttpError(400, "path required");
  const orig = origRaw ? cleanRel(origRaw) : rel;
  const [original, modified] = await Promise.all([readSide(root, d.a, orig, reveal), readSide(root, d.b, rel, reveal)]);
  return { path: rel, orig_path: orig !== rel ? orig : undefined, language: languageOf(rel), label: d.label, original, modified };
}
