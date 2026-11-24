import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { Badge, Card, Dialog, Select, StateDot } from "../components/ui";
import { ago, cn, fmtTokens } from "../lib/utils";
import { activityQuery, groupByProject, heartbeatTone, type Activity, type ActivityRow } from "../lib/activity";
import type { LogEvent } from "../lib/types";

const TONE: Record<string, string> = { ok: "text-ok", warn: "text-warn", danger: "text-danger" };

/** Who is doing what: live runs grouped by project, plus recent history (docs/PHASE2.md 2.7). */
export function ActivityPage() {
  const { state, logs, activityTick, toast } = useStore();
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [data, setData] = useState<Activity>({ live: [], history: [] });
  const [open, setOpen] = useState<ActivityRow | null>(null);
  const [runLog, setRunLog] = useState<LogEvent[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    api<Activity>(activityQuery({ project, agent, limit: 30 })).then(setData).catch((e) => toast(String(e.message ?? e)));
  }, [project, agent, activityTick, toast]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!open) return;
    const own = logs.filter((l) => l.run_id === open.run_id);
    if (!open.task_id) { setRunLog(own); return; }
    api<LogEvent[]>(`/api/tasks/${open.task_id}/log`).then((l) => setRunLog(l.filter((x) => x.run_id === open.run_id))).catch(() => setRunLog(own));
  }, [open, logs]);
  if (!state) return null;
  const stuck = state.settings.stuck_minutes;

  const table = (rows: ActivityRow[], live: boolean) => (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr><th className="px-3 py-1.5">Agent</th><th>Task</th><th>Status</th><th>Branch / PR</th><th>Runner</th><th>{live ? "Heartbeat" : "Ended"}</th><th className="pr-3 text-right">Tokens</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.run_id} onClick={() => setOpen(r)} className="cursor-pointer border-t hover:bg-muted/50" title="Open the live log">
            <td className="px-3 py-1.5"><span className="flex items-center gap-2"><StateDot state={r.state ?? ""} />{r.agent ?? r.agent_id}</span></td>
            <td className="max-w-[18rem] truncate">{r.task ?? <span className="text-muted-foreground">{r.kind ?? "-"}</span>}{r.task_type && r.task_type !== "code" && <Badge className="ml-1">{r.task_type}</Badge>}</td>
            <td>{r.status ?? "-"}{!live && r.exit_reason && <span className="ml-1 text-xs text-muted-foreground">({r.exit_reason})</span>}</td>
            <td className="font-mono text-xs">
              {r.branch ?? "-"}
              {r.pr_url && <a href={r.pr_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="ml-1 inline-flex items-center gap-0.5 text-primary">#{r.pr}<ExternalLink size={11} /></a>}
            </td>
            <td className="text-xs">{r.runner ?? "-"}{r.sandbox_name && <div className="font-mono text-muted-foreground">{r.sandbox_name}</div>}</td>
            <td className={cn("text-xs", live && TONE[heartbeatTone(r.last_heartbeat_at, now, stuck)])}>
              {live ? (r.last_heartbeat_at ? `${ago(r.last_heartbeat_at)} ago` : "no heartbeat") : r.ended_at ? `${ago(r.ended_at)} ago` : "-"}
            </td>
            <td className="pr-3 text-right tabular-nums">{fmtTokens(r.tokens ?? 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">Who is doing what</h2>
        <Select className="w-48" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project filter">
          <option value="">All projects</option>
          {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select className="w-48" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent filter">
          <option value="">All agents</option>
          {state.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </div>
      {data.live.length === 0 && <Card className="p-6 text-center text-sm text-muted-foreground">Nobody is working right now.</Card>}
      {groupByProject(data.live).map((g) => (
        <Card key={g.project} className="overflow-hidden">
          <div className="border-b px-3 py-2 text-xs font-medium">{g.project} <span className="text-muted-foreground">({g.rows.length} live)</span></div>
          {table(g.rows, true)}
        </Card>
      ))}
      <Card className="overflow-hidden">
        <div className="border-b px-3 py-2 text-xs font-medium">Recent history</div>
        {data.history.length ? table(data.history, false) : <div className="p-4 text-center text-sm text-muted-foreground">No finished runs yet.</div>}
      </Card>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={`${open?.agent ?? ""}${open?.task ? `: ${open.task}` : ""}`} wide>
        <div className="max-h-[60vh] overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">
          {runLog.map((l, i) => <div key={i} className="whitespace-pre-wrap break-words"><span className="text-muted-foreground">{new Date(l.ts).toLocaleTimeString()} {l.kind} </span>{l.text}</div>)}
          {runLog.length === 0 && <div className="text-muted-foreground">{open?.last_event ? `${open.last_event.kind}: ${open.last_event.text}` : "No log yet."}</div>}
        </div>
      </Dialog>
    </div>
  );
}
