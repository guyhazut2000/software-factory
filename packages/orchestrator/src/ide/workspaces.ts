import { existsSync } from "node:fs";
import path from "node:path";
import type { Db, Row } from "../db.js";
import { dataDir } from "../util.js";
import { HttpError } from "./paths.js";

/**
 * An IDE workspace: a root folder on this machine, optionally pinned to a git ref (read from the object DB).
 * Ids: `p-<projectId>` (the project's main mirror or folder) and `t-<taskId>` (an agent's task worktree, or its pushed branch).
 */
export interface IdeWorkspace { id: string; label: string; kind: "main" | "folder" | "task"; project_id: string | null; task_id?: string; root: string; ref?: string; git: boolean; read_only: boolean; note?: string }

export const taskWorktreeDir = (taskId: string) => path.join(dataDir(), "work", taskId);
const isGitDir = (root: string) => existsSync(path.join(root, ".git"));

function projectWs(p: Row): IdeWorkspace | undefined {
  if (!p.root_path) return undefined;
  if (p.kind === "github") return { id: `p-${p.id}`, label: `${p.repo} (main mirror)`, kind: "main", project_id: p.id, root: p.root_path, git: true, read_only: true, note: "The orchestrator resets this clone on every sync, so it is read-only." };
  if (p.kind === "folder") return { id: `p-${p.id}`, label: p.name, kind: "folder", project_id: p.id, root: p.root_path, git: isGitDir(p.root_path), read_only: true };
  return undefined;
}

function taskWs(t: Row, p: Row | undefined): IdeWorkspace | undefined {
  if (!p?.root_path || !t.branch) return undefined;
  const label = `${t.issue_number ? `#${t.issue_number} ` : ""}${t.title}`.slice(0, 80);
  const dir = taskWorktreeDir(t.id);
  if (existsSync(path.join(dir, ".git"))) return { id: `t-${t.id}`, label, kind: "task", project_id: p.id, task_id: t.id, root: dir, git: true, read_only: true, note: "Agent worktree (live)." };
  // sbx runner or finished task: read the pushed branch from the project's clone.
  return { id: `t-${t.id}`, label, kind: "task", project_id: p.id, task_id: t.id, root: p.root_path, ref: `origin/${t.branch}`, git: true, read_only: true, note: `Pushed branch ${t.branch}.` };
}

export function listWorkspaces(db: Db): IdeWorkspace[] {
  const projects = db.all("SELECT * FROM projects ORDER BY created_at");
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out = projects.map(projectWs).filter((w): w is IdeWorkspace => !!w);
  for (const t of db.all("SELECT * FROM tasks WHERE type='code' AND branch IS NOT NULL AND status<>'done' ORDER BY updated_at DESC LIMIT 50")) {
    const w = taskWs(t, byId.get(t.project_id));
    if (w) out.push(w);
  }
  return out;
}

export function getWorkspace(db: Db, wid: string): IdeWorkspace {
  const m = /^([pt])-([A-Za-z0-9-]{1,64})$/.exec(wid);
  if (!m) throw new HttpError(400, "bad workspace id");
  if (m[1] === "p") {
    const p = db.get("SELECT * FROM projects WHERE id=?", m[2]);
    const w = p && projectWs(p);
    if (!w) throw new HttpError(404, "workspace not found");
    return w;
  }
  const t = db.get("SELECT * FROM tasks WHERE id=?", m[2]);
  const w = t && taskWs(t, db.get("SELECT * FROM projects WHERE id=?", t.project_id));
  if (!w) throw new HttpError(404, "workspace not found (the task has no branch yet)");
  return w;
}
