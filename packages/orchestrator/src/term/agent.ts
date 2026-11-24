import type { Workspace } from "../workspace.js";
import type { Row } from "../db.js";
import { HttpError } from "../ide/paths.js";
import { run, which } from "../util.js";
import { defaultShell, type TermRegistry, type TermSession } from "./pty.js";

export type AgentLookup = (agentId: string) => { ws?: Workspace; agent: Row; task: Row | null } | undefined;

/** Shell started inside the sandbox: bash if the image has it, else sh. */
export const SBX_SHELL = ["sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh"];

/** Is the named sandbox listed by `sbx ls` and not stopped? */
export async function sandboxRunning(name: string): Promise<boolean> {
  const ls = await run("sbx", ["ls"], { timeoutMs: 20_000 });
  if (ls.code !== 0) throw new HttpError(503, `sbx ls failed: ${(ls.stderr || ls.stdout).trim().slice(0, 200)}`);
  const line = ls.stdout.split(/\r?\n/).find((l) => l.split(/\s+/).includes(name));
  return !!line && !/\b(stopped|exited|paused|created)\b/i.test(line);
}

/**
 * Open a terminal for a running agent: `sbx exec -it <sandbox> <shell>` for sandboxed runs, a host shell in the
 * worktree for worktree runs. 409 = agent/sandbox not running, 503 = sbx not installed.
 */
export async function openAgentShell(terms: TermRegistry, lookup: AgentLookup, agentId: string, b: Record<string, unknown>): Promise<TermSession> {
  const hit = lookup(agentId);
  if (!hit) throw new HttpError(409, "agent is not running, so it has no workspace to open a shell in");
  const ws = hit.ws;
  if (!ws) throw new HttpError(409, "agent workspace is still being prepared, try again in a moment");
  const name = String(hit.agent.name ?? agentId);
  const label = `${name}${hit.task ? ` · ${String(hit.task.title ?? hit.task.id).slice(0, 40)}` : ""}`;
  const workspace_id = `agent:${agentId}`;
  const dims = { cols: b.cols as number, rows: b.rows as number };
  if (ws.kind === "sbx") {
    const sbx = which("sbx");
    if (!sbx) throw new HttpError(503, "sbx (Docker Sandboxes CLI) is not installed or not on PATH");
    if (!ws.sandbox) throw new HttpError(409, "sandbox name unknown for this run");
    if (!(await sandboxRunning(ws.sandbox))) throw new HttpError(409, `sandbox ${ws.sandbox} is not running`);
    return terms.create({ cwd: ws.hostDir, workspace_id, label: `${label} (sbx)`, ...dims, shell: { file: sbx, args: ["exec", "-it", ws.sandbox, ...SBX_SHELL] } });
  }
  return terms.create({ cwd: ws.hostDir, workspace_id, label: `${label} (worktree)`, ...dims, shell: defaultShell() });
}
