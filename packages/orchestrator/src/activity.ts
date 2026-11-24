import type { Db } from "./db.js";

export type ActivityFilter = { project?: string | null; agent?: string | null; limit?: number };

const COLS = `r.id AS run_id, r.agent_id, a.name AS agent, a.state, r.task_id, t.title AS task, t.type AS task_type, t.status,
  t.branch, t.pr_number AS pr, t.pr_url, r.runner, r.kind, r.started_at, r.ended_at, r.exit_reason, r.last_heartbeat_at, r.tokens,
  p.id AS project_id, p.name AS project`;
const FROM = `FROM runs r LEFT JOIN agents a ON a.id=r.agent_id LEFT JOIN tasks t ON t.id=r.task_id LEFT JOIN projects p ON p.id=t.project_id`;

/** Sandbox name as created by workspace.ts (`sf-<task8>`); only sbx runs with a task have one. */
export function sandboxName(runner: unknown, taskId: unknown): string | null {
  return runner === "sbx" && typeof taskId === "string" ? `sf-${taskId.slice(0, 8)}` : null;
}

/** Who is doing what: a derived view over runs/agents/tasks/projects + latest event (docs/PHASE2.md 2.7). */
export function activity(db: Db, f: ActivityFilter = {}) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.project) {
    where.push("t.project_id=?");
    args.push(f.project);
  }
  if (f.agent) {
    where.push("r.agent_id=?");
    args.push(f.agent);
  }
  const w = where.length ? ` AND ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(200, Math.floor(f.limit ?? 20)));
  const shape = (r: Record<string, unknown>) => {
    const ev = db.all("SELECT ts,kind,text FROM events WHERE run_id=? ORDER BY id DESC LIMIT 1", r.run_id)[0] ?? null;
    return { ...r, sandbox_name: sandboxName(r.runner, r.task_id), last_event: ev };
  };
  const live = db.all(`SELECT ${COLS} ${FROM} WHERE r.ended_at IS NULL${w} ORDER BY r.started_at DESC`, ...args).map(shape);
  const history = db.all(`SELECT ${COLS} ${FROM} WHERE r.ended_at IS NOT NULL${w} ORDER BY r.ended_at DESC LIMIT ?`, ...args, limit).map(shape);
  return { live, history };
}
