import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Db, Row } from "../db.js";
import { dataDir } from "../util.js";
import { HttpError } from "./paths.js";

/**
 * An IDE workspace: a root folder on this machine, optionally pinned to a git ref (read from the object DB).
 * Ids: `p-<projectId>` (the project's main mirror or folder), `m-<projectId>` (Guy's own edit clone, "My workspace")
 * and `t-<taskId>` (an agent's task worktree, or its pushed branch). Only `mine` workspaces are writable.
 */
export interface IdeWorkspace { id: string; label: string; kind: "main" | "folder" | "task" | "mine"; exists?: boolean; project_id: string | null; task_id?: string; root: string; ref?: string; git: boolean; read_only: boolean; note?: string; lease?: Lease }

/** Edit lease of a task workspace: an agent owns it while its run is active; Guy owns it after "take over". */
export interface Lease { owner: "agent" | "guy"; agent?: string }
/** Returns the name of the agent currently running this task, if any. */
export type RunningAgent = (taskId: string) => string | undefined;

export const taskWorktreeDir = (taskId: string) => path.join(dataDir(), "work", taskId);
const isGitDir = (root: string) => existsSync(path.join(root, ".git"));
/** Guy's per-project edit clone. Never used by agents or reset by sync. */
export const myWorkspaceDir = (projectId: string) => path.join(dataDir(), "ide", projectId);

function mineWs(p: Row): IdeWorkspace | undefined {
  if (!p.root_path || !(p.kind === "github" || (p.kind === "folder" && isGitDir(p.root_path)))) return undefined;
  const root = myWorkspaceDir(p.id);
  const exists = isGitDir(root);
  return { id: `m-${p.id}`, label: `${p.kind === "github" ? p.repo : p.name} (my workspace)`, kind: "mine", project_id: p.id, root, git: true, read_only: !exists, exists, note: exists ? "Your own clone: edit, commit and push branches here. Agents never touch it." : "Not created yet: create it to edit this project." };
}

/** Create "My workspace" by cloning the project's mirror; origin then points at the mirror's own origin (GitHub). Idempotent. */
export function createMyWorkspace(db: Db, projectId: string): IdeWorkspace {
  const p = db.get("SELECT * FROM projects WHERE id=?", projectId);
  const w = p && mineWs(p);
  if (!w) throw new HttpError(404, "this project has no git repository to clone");
  if (w.exists) return w;
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).toString().trim();
  let upstream = "";
  try {
    upstream = g(p.root_path, "config", "--get", "remote.origin.url");
  } catch {
    /* local-only repo */
  }
  mkdirSync(path.dirname(w.root), { recursive: true });
  rmSync(w.root, { recursive: true, force: true }); // leftover of a failed clone (no .git)
  try {
    g(path.dirname(w.root), "clone", "-q", "--no-hardlinks", "--", p.root_path, w.root);
    if (upstream) g(w.root, "remote", "set-url", "origin", upstream);
  } catch (e) {
    rmSync(w.root, { recursive: true, force: true });
    throw new HttpError(500, `could not create my workspace: ${(e as Error).message.split("\n")[0]}`);
  }
  return mineWs(p)!;
}

function projectWs(p: Row): IdeWorkspace | undefined {
  if (!p.root_path) return undefined;
  if (p.kind === "github") return { id: `p-${p.id}`, label: `${p.repo} (main mirror)`, kind: "main", project_id: p.id, root: p.root_path, git: true, read_only: true, note: "The orchestrator resets this clone on every sync, so it is read-only." };
  if (p.kind === "folder") return { id: `p-${p.id}`, label: p.name, kind: "folder", project_id: p.id, root: p.root_path, git: isGitDir(p.root_path), read_only: true };
  return undefined;
}

function taskWs(t: Row, p: Row | undefined, running?: RunningAgent): IdeWorkspace | undefined {
  if (!p?.root_path || !t.branch) return undefined;
  const label = `${t.issue_number ? `#${t.issue_number} ` : ""}${t.title}`.slice(0, 80);
  const dir = taskWorktreeDir(t.id);
  const agent = running?.(t.id);
  const local = existsSync(path.join(dir, ".git"));
  if (agent) {
    const base = { id: `t-${t.id}`, label, kind: "task" as const, project_id: p.id, task_id: t.id, git: true, read_only: true, lease: { owner: "agent" as const, agent }, note: `${agent} is working here. Take over to edit.` };
    return local ? { ...base, root: dir } : { ...base, root: p.root_path, ref: `origin/${t.branch}` };
  }
  if (t.lease === "guy" && local) return { id: `t-${t.id}`, label, kind: "task", project_id: p.id, task_id: t.id, root: dir, git: true, read_only: false, lease: { owner: "guy" }, note: "You took over: edit and commit here, then hand back to the agent." };
  if (local) return { id: `t-${t.id}`, label, kind: "task", project_id: p.id, task_id: t.id, root: dir, git: true, read_only: true, note: "Agent worktree (live)." };
  // sbx runner or finished task: read the pushed branch from the project's clone.
  return { id: `t-${t.id}`, label, kind: "task", project_id: p.id, task_id: t.id, root: p.root_path, ref: `origin/${t.branch}`, git: true, read_only: true, note: `Pushed branch ${t.branch}.` };
}

export function listWorkspaces(db: Db, running?: RunningAgent): IdeWorkspace[] {
  const projects = db.all("SELECT * FROM projects ORDER BY created_at");
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out = projects.flatMap((p) => [projectWs(p), mineWs(p)]).filter((w): w is IdeWorkspace => !!w);
  for (const t of db.all("SELECT * FROM tasks WHERE type='code' AND branch IS NOT NULL AND status<>'done' ORDER BY updated_at DESC LIMIT 50")) {
    const w = taskWs(t, byId.get(t.project_id), running);
    if (w) out.push(w);
  }
  return out;
}

export function getWorkspace(db: Db, wid: string, running?: RunningAgent): IdeWorkspace {
  const m = /^([ptm])-([A-Za-z0-9-]{1,64})$/.exec(wid);
  if (!m) throw new HttpError(400, "bad workspace id");
  if (m[1] !== "t") {
    const p = db.get("SELECT * FROM projects WHERE id=?", m[2]);
    const w = p && (m[1] === "p" ? projectWs(p) : mineWs(p));
    if (!w) throw new HttpError(404, "workspace not found");
    return w;
  }
  const t = db.get("SELECT * FROM tasks WHERE id=?", m[2]);
  const w = t && taskWs(t, db.get("SELECT * FROM projects WHERE id=?", t.project_id), running);
  if (!w) throw new HttpError(404, "workspace not found (the task has no branch yet)");
  return w;
}
