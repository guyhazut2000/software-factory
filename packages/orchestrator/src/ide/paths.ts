import { realpathSync } from "node:fs";
import path from "node:path";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);

/** True if `child` is `root` or inside it (both absolute, already normalised). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Validate a client-supplied relative path: no NUL, no absolute, no drive letters, no `..` segments. Returns posix form ('' = root). */
export function cleanRel(rel: unknown): string {
  if (rel === undefined || rel === null || rel === "") return "";
  if (typeof rel !== "string" || rel.includes("\0") || rel.length > 1024) throw new HttpError(400, "bad path");
  const p = rel.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) throw new HttpError(400, "absolute paths are not allowed");
  const parts = p.split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) throw new HttpError(400, "'..' is not allowed");
  return parts.join("/");
}

/**
 * Resolve `rel` inside `root` on disk. The real path (after symlinks) must stay inside the real root,
 * so `..`, absolute paths and symlinks that point outside are all refused.
 */
export function resolveInside(root: string, rel: unknown): { abs: string; rel: string } {
  const r = cleanRel(rel);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new HttpError(404, "workspace folder does not exist yet");
  }
  const abs = path.resolve(realRoot, r);
  if (!isInside(realRoot, abs)) throw new HttpError(403, "path escapes the workspace");
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new HttpError(404, "not found");
  }
  if (!isInside(realRoot, real)) throw new HttpError(403, "symlink points outside the workspace");
  return { abs: real, rel: r };
}

const SECRET = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /^id_[a-z0-9]+$/i, /\.p12$/i, /\.pfx$/i];
export const isSecretName = (name: string) => SECRET.some((re) => re.test(path.posix.basename(name)));

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", md: "markdown", markdown: "markdown", css: "css", scss: "scss", less: "less", html: "html", htm: "html", vue: "html",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", cs: "csharp", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  php: "php", swift: "swift", sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", sql: "sql", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  xml: "xml", svg: "xml", graphql: "graphql", gql: "graphql", dockerfile: "dockerfile", r: "r", lua: "lua", dart: "dart", scala: "scala",
};
export function languageOf(name: string): string {
  const base = path.posix.basename(name).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile") return "makefile";
  return LANG[base.split(".").pop() ?? ""] ?? "plaintext";
}

export const MAX_FILE = 2 * 1024 * 1024;
export const looksBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);
