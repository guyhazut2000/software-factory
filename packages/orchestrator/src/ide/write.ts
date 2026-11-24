import { lstatSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { sha } from "./files.js";
import { HttpError, MAX_FILE, cleanRel, resolveInside } from "./paths.js";

/**
 * Resolve a path to write inside `root`. The parent must exist inside the workspace (same sandboxing as reads:
 * no `..`, no absolute paths, no symlinks out). The root itself and anything under `.git` are refused.
 */
export function writeTarget(root: string, rel: unknown): { abs: string; rel: string; exists: boolean } {
  const r = cleanRel(rel);
  if (!r) throw new HttpError(400, "refusing to write the workspace root");
  if (r.split("/").some((s) => s.toLowerCase() === ".git")) throw new HttpError(403, "refusing to touch .git");
  const parent = resolveInside(root, path.posix.dirname(r) === "." ? "" : path.posix.dirname(r));
  const abs = path.join(parent.abs, path.posix.basename(r));
  let exists = false;
  try {
    lstatSync(abs);
    exists = true;
  } catch { /* new path */ }
  if (exists) resolveInside(root, r); // a symlink must point inside; we still act on the link itself, not its target
  return { abs, rel: r, exists };
}

function atomicWrite(abs: string, content: string) {
  const tmp = `${abs}.sf-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, abs);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Save a text file. `base_sha` is the sha256 the client loaded; null/"" means "create, must not exist".
 * Any mismatch is a 409 carrying `current_sha` (null if the file is gone) so the UI can show a conflict diff.
 */
export function saveFile(root: string, rel: unknown, content: unknown, base_sha: unknown) {
  if (typeof content !== "string") throw new HttpError(400, "content must be a string");
  if (Buffer.byteLength(content) > MAX_FILE) throw new HttpError(413, "file too large");
  const t = writeTarget(root, rel);
  const want = typeof base_sha === "string" && base_sha ? base_sha : null;
  let current: string | null = null;
  if (t.exists) {
    if (!statSync(t.abs).isFile()) throw new HttpError(400, "not a file");
    current = sha(readFileSync(t.abs));
  }
  if (current !== want) throw new HttpError(409, current ? "the file changed since you opened it" : "the file no longer exists", { conflict: true, current_sha: current });
  atomicWrite(t.abs, content);
  return { path: t.rel, sha256: sha(content), size: Buffer.byteLength(content) };
}

/** create (empty file) | mkdir | rename (to) | delete. */
export function fsOp(root: string, b: Record<string, unknown>) {
  const op = b.op;
  if (op === "create") {
    const t = writeTarget(root, b.path);
    if (t.exists) throw new HttpError(409, "already exists", { conflict: true });
    writeFileSync(t.abs, "", { flag: "wx" });
    return { ok: true, path: t.rel };
  }
  if (op === "mkdir") {
    const t = writeTarget(root, b.path);
    if (t.exists) throw new HttpError(409, "already exists", { conflict: true });
    mkdirSync(t.abs);
    return { ok: true, path: t.rel };
  }
  if (op === "rename") {
    const from = writeTarget(root, b.path);
    if (!from.exists) throw new HttpError(404, "not found");
    const to = writeTarget(root, b.to);
    if (to.exists && to.abs.toLowerCase() !== from.abs.toLowerCase()) throw new HttpError(409, "target already exists", { conflict: true });
    if (to.rel === from.rel || to.rel.startsWith(`${from.rel}/`)) throw new HttpError(400, "cannot move a folder into itself");
    renameSync(from.abs, to.abs);
    return { ok: true, path: to.rel };
  }
  if (op === "delete") {
    const t = writeTarget(root, b.path);
    if (!t.exists) throw new HttpError(404, "not found");
    rmSync(t.abs, { recursive: true });
    return { ok: true, path: t.rel };
  }
  throw new HttpError(400, "op must be create, mkdir, rename or delete");
}

