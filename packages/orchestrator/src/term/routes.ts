import type { Db } from "../db.js";
import { getWorkspace, type RunningAgent } from "../ide/workspaces.js";
import { HttpError, resolveInside } from "../ide/paths.js";
import { loadPty, ptyError, type TermRegistry } from "./pty.js";
import { openAgentShell, type AgentLookup } from "./agent.js";

/**
 * cwd allowlist: a terminal may only start inside an on-disk project workspace (my workspace, local folder,
 * main mirror or a live agent worktree), optionally in a subfolder. Workspaces pinned to a git ref have no folder.
 */
export function terminalCwd(db: Db, wid: unknown, rel: unknown, running?: RunningAgent): { cwd: string; label: string; workspace_id: string } {
  if (typeof wid !== "string" || !wid) throw new HttpError(400, "workspace required");
  const w = getWorkspace(db, wid, running);
  if (w.ref) throw new HttpError(400, "this workspace has no folder on disk");
  if (w.kind === "mine" && !w.exists) throw new HttpError(400, "create your workspace first");
  const { abs, rel: r } = resolveInside(w.root, rel);
  return { cwd: abs, label: r ? `${w.label}/${r}` : w.label, workspace_id: w.id };
}

/** REST: GET /api/term (list + availability), POST /api/term {workspace, path?, cols?, rows?}, POST /api/term/agent/:agentId {cols?, rows?}, DELETE /api/term/:id. */
export function termRoute(db: Db, terms: TermRegistry, method: string, url: URL, b: Record<string, unknown>, running?: RunningAgent, agentWs?: AgentLookup): unknown {
  const seg = url.pathname.split("/").filter(Boolean); // api term :id?
  if (seg[1] !== "term") return undefined;
  if (seg.length === 2 && method === "GET") return { available: !!loadPty(), error: ptyError() || undefined, sessions: terms.list() };
  if (seg.length === 2 && method === "POST") {
    const c = terminalCwd(db, b.workspace, b.path, running);
    return terms.info(terms.create({ ...c, cols: b.cols as number, rows: b.rows as number }));
  }
  if (seg.length === 4 && seg[2] === "agent" && method === "POST") {
    if (!agentWs) throw new HttpError(503, "agent shells unavailable");
    return openAgentShell(terms, agentWs, decodeURIComponent(seg[3]!), b).then((s) => terms.info(s));
  }
  if (seg.length === 3 && method === "DELETE") {
    if (!terms.kill(seg[2]!)) throw new HttpError(404, "unknown session");
    return { ok: true };
  }
  throw new HttpError(404, "not found");
}
