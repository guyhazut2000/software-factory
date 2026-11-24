import type { Db } from "../db.js";
import { atRef, disk, gitText, verifyRef } from "./files.js";
import { HttpError, cleanRel } from "./paths.js";
import { getWorkspace, listWorkspaces, type IdeWorkspace } from "./workspaces.js";

const showSecrets = (db: Db, w: IdeWorkspace) => !!w.project_id && db.getSetting<string[]>("show_secrets", []).includes(w.project_id);

async function refFor(w: IdeWorkspace, q: URLSearchParams): Promise<string | undefined> {
  const ref = q.get("ref") || w.ref;
  if (!ref) return undefined;
  if (!w.git) throw new HttpError(400, "this workspace is not a git repository");
  return verifyRef(w.root, ref);
}

/** Recent commits, optionally for one path. */
export async function gitLog(w: IdeWorkspace, ref: string | undefined, rel: unknown, limit = 50) {
  if (!w.git) return [];
  const r = cleanRel(rel);
  const out = await gitText(w.root, ["log", "-z", `-n${Math.min(200, Math.max(1, limit))}`, "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s", ref ?? "HEAD", "--", ...(r ? [r] : [])]);
  return out.split("\0").filter(Boolean).map((l) => {
    const [sha, author, email, at, subject] = l.replace(/^\n/, "").split("\x1f");
    return { sha, author, email, at: Number(at) * 1000, subject };
  });
}

/** `/api/ws/...` routes (read-only in M1). Returns undefined if the path is not an IDE route. */
export async function ideRoute(db: Db, method: string, url: URL, b: Record<string, unknown>): Promise<unknown> {
  const seg = url.pathname.split("/").filter(Boolean); // api ws :wid ...rest
  if (seg[1] !== "ws") return undefined;
  if (seg.length === 2 && method === "GET") return listWorkspaces(db);
  const w = getWorkspace(db, seg[2] ?? "");
  const rest = seg.slice(3).join("/");
  const q = url.searchParams;
  if (method === "GET" && rest === "") return { ...w, show_secrets: showSecrets(db, w) };
  if (method === "GET" && rest === "tree") {
    const ref = await refFor(w, q);
    return ref ? atRef.tree(w.root, ref, q.get("path")) : disk.tree(w.root, q.get("path"));
  }
  if (method === "GET" && rest === "file") {
    const ref = await refFor(w, q);
    const reveal = showSecrets(db, w);
    return ref ? atRef.file(w.root, ref, q.get("path"), reveal) : disk.file(w.root, q.get("path"), reveal);
  }
  if (method === "GET" && rest === "git/log") return gitLog(w, await refFor(w, q), q.get("path"), Number(q.get("limit") ?? 50));
  if (method === "POST" && rest === "show-secrets") {
    if (!w.project_id) throw new HttpError(400, "no project");
    const cur = new Set(db.getSetting<string[]>("show_secrets", []));
    if (b.on) cur.add(w.project_id);
    else cur.delete(w.project_id);
    db.setSetting("show_secrets", [...cur]);
    return { show_secrets: !!b.on };
  }
  throw new HttpError(404, "not found");
}
