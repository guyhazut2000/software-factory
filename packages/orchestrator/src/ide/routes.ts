import type { Db } from "../db.js";
import { atRef, disk, gitText, verifyRef } from "./files.js";
import { HttpError, cleanRel } from "./paths.js";
import { diffFiles, diffPair, diffSpec, status } from "./gitread.js";
import { fsOp, saveFile } from "./write.js";
import { createMyWorkspace, getWorkspace, listWorkspaces, type IdeWorkspace } from "./workspaces.js";

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

/** `/api/ws/...` routes (writes only in writable workspaces). Returns undefined if the path is not an IDE route. */
export async function ideRoute(db: Db, method: string, url: URL, b: Record<string, unknown>): Promise<unknown> {
  const seg = url.pathname.split("/").filter(Boolean); // api ws :wid ...rest
  if (seg[1] !== "ws") return undefined;
  if (seg.length === 2 && method === "GET") return listWorkspaces(db);
  const w = getWorkspace(db, seg[2] ?? "");
  const rest = seg.slice(3).join("/");
  const q = url.searchParams;
  if (method === "POST" && rest === "create") {
    if (w.kind !== "mine") throw new HttpError(400, "only 'my workspace' can be created");
    return createMyWorkspace(db, w.project_id!);
  }
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
  if (method === "GET" && rest === "git/status") {
    if (!w.git) throw new HttpError(400, "this workspace is not a git repository");
    if (w.ref) return { branch: w.ref, detached: false, upstream: null, ahead: 0, behind: 0, changes: [], truncated: false, pinned: true };
    return status(w.root);
  }
  if (method === "GET" && rest === "git/diff") {
    if (!w.git) throw new HttpError(400, "this workspace is not a git repository");
    let mode = q.get("mode") ?? "unstaged";
    let base = q.get("base");
    let head = q.get("head");
    let worktree = false;
    if (mode === "task") {
      const p = w.project_id ? db.get("SELECT default_branch FROM projects WHERE id=?", w.project_id) : undefined;
      if (!w.task_id || !p) throw new HttpError(400, "mode=task needs a task workspace");
      mode = "range";
      base = `origin/${p.default_branch}`;
      head = w.ref ?? null;
      worktree = !w.ref;
    } else if (w.ref && mode !== "range") throw new HttpError(400, "this workspace is a pushed branch: use mode=task or mode=range");
    const spec = await diffSpec(w.root, { mode, base, head, worktree });
    if (!q.get("path")) return { label: spec.label, ...(await diffFiles(w.root, spec)) };
    return diffPair(w.root, spec, q.get("path"), q.get("orig"), showSecrets(db, w));
  }
  if ((method === "PUT" && rest === "file") || (method === "POST" && rest === "fs")) {
    // Only Guy's own edit clone is writable; mirrors, folders and agent workspaces stay read-only.
    if (w.kind !== "mine" || !w.exists || w.read_only || w.ref) throw new HttpError(403, "this workspace is read-only");
    return rest === "file" ? saveFile(w.root, q.get("path"), b.content, b.base_sha) : fsOp(w.root, b);
  }
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
