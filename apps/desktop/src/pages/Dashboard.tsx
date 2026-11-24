import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, GitMerge, RotateCw, ScrollText, Square } from "lucide-react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { Badge, Button, Card, Dialog, StateDot, Switch } from "../components/ui";
import { ago, cn, fmtTokens } from "../lib/utils";
import type { LogEvent, Task } from "../lib/types";

const COLUMNS: [string, string][] = [["queued", "Queued"], ["working", "Working"], ["waiting_for_guy", "Waiting for you"], ["in_review", "In review"], ["done", "Done"], ["failed", "Failed"]];
const KIND_COLOR: Record<string, string> = { error: "text-danger", stderr: "text-warn", supervisor: "text-warn", blocked: "text-danger", tool: "text-muted-foreground", progress: "text-ok", question: "text-warn", system: "text-primary" };

export function Dashboard({ goto }: { goto: (t: string) => void }) {
  const { state, logs, refresh, toast } = useStore();
  const [filter, setFilter] = useState<string | null>(null);
  const [logTask, setLogTask] = useState<Task | null>(null);
  const [taskLog, setTaskLog] = useState<LogEvent[]>([]);
  const wrap = (fn: () => Promise<unknown>) => fn().then(refresh).catch((e) => toast(String(e.message ?? e)));
  const endRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => logs.filter((l) => !filter || l.agent_id === filter), [logs, filter]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [shown.length]);
  useEffect(() => { if (logTask) api<LogEvent[]>(`/api/tasks/${logTask.id}/log`).then(setTaskLog).catch(() => {}); }, [logTask, logs.length]);
  if (!state) return null;
  const agentName = (id: string | null) => state.agents.find((a) => a.id === id)?.name ?? "";
  const project = (id: string | null) => state.projects.find((p) => p.id === id)?.name ?? "";

  return (
    <div className="flex h-full flex-col gap-4">
      {state.questions.length > 0 && (
        <Card className="flex items-center justify-between border-warn/50 bg-warn/10 px-4 py-2">
          <span>{state.questions.length} question{state.questions.length > 1 ? "s" : ""} waiting for you</span>
          <Button size="sm" onClick={() => goto("chief")}>Answer</Button>
        </Card>
      )}
      {state.agents.length === 0 && (
        <Card className="p-6 text-center"><div className="mb-1 font-medium">No agents yet</div><div className="mb-3 text-muted-foreground">Add a Chief, a Developer and a Reviewer from templates, then link a project.</div><Button onClick={() => goto("agents")}>Create agents</Button></Card>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
        {state.agents.map((a) => {
          const task = state.tasks.find((t) => t.id === a.current_task_id);
          const run = state.running.find((r) => r.agent_id === a.id);
          return (
            <Card key={a.id} className={cn("p-3", filter === a.id && "ring-2 ring-primary")}>
              <div className="flex items-center gap-2">
                <StateDot state={a.state} />
                <button className="cursor-pointer truncate font-medium" onClick={() => setFilter(filter === a.id ? null : a.id)}>{a.name}</button>
                <Badge className="ml-auto">{a.role}</Badge>
                <Switch checked={a.enabled} onChange={(on) => wrap(() => api(`/api/agents/${a.id}/toggle`, "POST", { on }))} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{a.provider} / {a.model} / {a.effort}</div>
              <div className="mt-2 h-8 text-xs">{task ? <>{a.state.replace(/_/g, " ")}: <span className="font-medium">{task.title}</span></> : <span className="text-muted-foreground">{a.state === "off" ? "switched off" : a.state.replace(/_/g, " ")}</span>}</div>
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span title="tokens today">{fmtTokens(a.tokens_today)}{a.token_budget ? ` / ${fmtTokens(a.token_budget)}` : ""} tok{run ? ` (run ${fmtTokens(run.tokens)})` : ""}</span>
                <Button size="sm" variant="ghost" onClick={() => wrap(() => api(`/api/agents/${a.id}/restart`, "POST", {}))} title="Restart (keeps progress)"><RotateCw size={12} />Restart</Button>
              </div>
            </Card>
          );
        })}
      </div>
      <div className="grid min-h-[300px] flex-1 grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
        <div className="flex min-h-0 gap-3 overflow-auto pb-2">
          {COLUMNS.map(([key, label]) => {
            const items = state.tasks.filter((t) => t.status === key);
            return (
              <div key={key} className="w-[210px] shrink-0 self-start rounded-xl bg-muted/50 p-2">
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">{label}<span>{items.length}</span></div>
                <div className="flex flex-col gap-2">
                  {items.map((t) => (
                    <Card key={t.id} className="p-2.5 text-xs">
                      <div className="font-medium leading-snug">{t.title}</div>
                      <div className="mt-1 text-muted-foreground">{project(t.project_id)}{t.issue_number ? ` #${t.issue_number}` : ""}{t.assignee_id ? ` / ${agentName(t.assignee_id)}` : ""}</div>
                      {t.note && <div className="mt-1 text-muted-foreground">{t.note}</div>}
                      {t.restart_count > 0 && <Badge tone="warn" className="mt-1">restarts {t.restart_count}</Badge>}
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setLogTask(t)}><ScrollText size={12} />Log</Button>
                        {t.pr_url && <a href={t.pr_url} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost"><ExternalLink size={12} />PR</Button></a>}
                        {t.status === "in_review" && <Button size="sm" onClick={() => confirm(`Squash-merge PR #${t.pr_number}?`) && wrap(() => api(`/api/tasks/${t.id}/merge`, "POST", {}))}><GitMerge size={12} />Merge</Button>}
                        {t.status === "working" && <Button size="sm" variant="outline" onClick={() => wrap(() => api(`/api/tasks/${t.id}/stop`, "POST", {}))}><Square size={12} />Stop</Button>}
                        {(t.status === "failed" || t.status === "queued") && <Button size="sm" variant="outline" onClick={() => wrap(() => api(`/api/tasks/${t.id}/retry`, "POST", {}))}><RotateCw size={12} />Retry</Button>}
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <Card className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-medium"><span>Live log {filter && `(${agentName(filter)})`}</span>{filter && <button className="cursor-pointer text-muted-foreground" onClick={() => setFilter(null)}>clear filter</button>}</div>
          <div className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
            {shown.length === 0 && <div className="p-2 text-muted-foreground">No activity yet.</div>}
            {shown.map((l, i) => (
              <div key={i} className={cn("whitespace-pre-wrap break-words", KIND_COLOR[l.kind])}>
                <span className="text-muted-foreground">{new Date(l.ts).toLocaleTimeString()} {agentName(l.agent_id)} </span>{l.text}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </Card>
      </div>
      <Dialog open={!!logTask} onClose={() => setLogTask(null)} title={logTask?.title ?? ""} wide>
        <div className="max-h-[60vh] overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">
          {taskLog.map((l, i) => <div key={i} className={cn("whitespace-pre-wrap break-words", KIND_COLOR[l.kind])}><span className="text-muted-foreground">{new Date(l.ts).toLocaleTimeString()} {l.kind} </span>{l.text}</div>)}
          {taskLog.length === 0 && <div className="text-muted-foreground">No log yet.</div>}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">Updated {logTask ? ago(logTask.updated_at) : ""} ago</div>
      </Dialog>
    </div>
  );
}
