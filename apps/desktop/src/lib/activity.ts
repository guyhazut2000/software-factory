/** Activity board rows as returned by GET /api/activity and the WS `activity` event (docs/PHASE2.md 2.7). */
export interface ActivityRow {
  run_id: string; agent_id: string; agent: string | null; state: string | null; task_id: string | null; task: string | null;
  task_type: string | null; status: string | null; branch: string | null; pr: number | null; pr_url: string | null;
  runner: string | null; kind: string | null; started_at: number; ended_at: number | null; exit_reason: string | null;
  last_heartbeat_at: number | null; tokens: number | null; project_id: string | null; project: string | null;
  sandbox_name: string | null; last_event: { ts: number; kind: string; text: string } | null;
}
export interface Activity { live: ActivityRow[]; history: ActivityRow[] }

/** Heartbeat health: ok under half the stuck threshold, warn under it, stale beyond (or never beat). */
export function heartbeatTone(lastBeat: number | null, now: number, stuckMinutes: number): "ok" | "warn" | "danger" {
  if (!lastBeat) return "danger";
  const age = now - lastBeat, stuck = Math.max(1, stuckMinutes) * 60_000;
  return age < stuck / 2 ? "ok" : age < stuck ? "warn" : "danger";
}

/** Group rows by project name (rows without a project go under "No project", last), keeping row order. */
export function groupByProject(rows: ActivityRow[]): { project: string; rows: ActivityRow[] }[] {
  const m = new Map<string, ActivityRow[]>();
  for (const r of rows) {
    const k = r.project ?? "";
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([k, rows]) => ({ project: k || "No project", rows }));
}

export function activityQuery(f: { project?: string; agent?: string; limit?: number }): string {
  const q = new URLSearchParams();
  if (f.project) q.set("project", f.project);
  if (f.agent) q.set("agent", f.agent);
  if (f.limit) q.set("limit", String(f.limit));
  const s = q.toString();
  return `/api/activity${s ? `?${s}` : ""}`;
}
