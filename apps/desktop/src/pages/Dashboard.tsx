import { useEffect, useMemo, useRef, useState } from "react";
import { openAgent } from "../lib/drawer";
import { Check, ExternalLink, FileDiff, GitMerge, Pencil, Plus, RotateCw, ScrollText, Square, Undo2 } from "lucide-react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { Badge, Button, Card, Dialog, Input, Label, Select, StateDot, Switch, Textarea } from "../components/ui";
import { ago, cn, fmtTokens } from "../lib/utils";
import type { LogEvent, Task } from "../lib/types";
import { sourceBadge } from "../lib/tasks";

const COLUMNS: [string, string][] = [["queued", "Queued"], ["working", "Working"], ["waiting_for_guy", "Waiting for you"], ["in_review", "In review"], ["done", "Done"], ["failed", "Failed"]];
type TaskForm = { id?: string; title: string; body: string; type: "manual" | "code"; project_id: string; priority: string };
const KIND_COLOR: Record<string, string> = { error: "text-danger", stderr: "text-warn", supervisor: "text-warn", blocked: "text-danger", tool: "text-muted-foreground", progress: "text-ok", question: "text-warn", system: "text-primary" };

export function Dashboard({ goto }: { goto: (t: string, arg?: string) => void }) {
  const { state, logs, refresh, toast } = useStore();
  const [filter, setFilter] = useState<string | null>(null);
  const [logTask, setLogTask] = useState<Task | null>(null);
  const [form, setForm] = useState<TaskForm | null>(null);
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
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">{label}<span className="flex items-center gap-1">{items.length}{key === "queued" && <button className="cursor-pointer hover:text-foreground" title="New local task" onClick={() => setForm({ title: "", body: "", type: "manual", project_id: "", priority: "" })}><Plus size={13} /></button>}</span></div>
                <div className="flex flex-col gap-2">
                  {items.map((t) => (
                    <Card key={t.id} className="p-2.5 text-xs">
                      <div className="font-medium leading-snug">{t.title}</div>
                      <div className="mt-1 flex flex-wrap gap-1"><Badge tone={sourceBadge(t).tone}>{sourceBadge(t).label}</Badge>{t.priority != null && <Badge>P{t.priority}</Badge>}</div>
                      <div className="mt-1 text-muted-foreground">{project(t.project_id) || (t.source === "local" ? "loose" : "")}{t.assignee_id && <> / <button className="cursor-pointer hover:underline" title="Open the agent drawer" onClick={() => openAgent(t.assignee_id!)}>{agentName(t.assignee_id)}</button></>}</div>
                      {t.note && <div className="mt-1 text-muted-foreground">{t.note}</div>}
                      {t.restart_count > 0 && <Badge tone="warn" className="mt-1">restarts {t.restart_count}</Badge>}
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setLogTask(t)}><ScrollText size={12} />Log</Button>
                        {t.branch && <Button size="sm" variant="ghost" title="Open this task's files and diff in the IDE" onClick={() => goto("ide", `t-${t.id}`)}><FileDiff size={12} />Diff</Button>}
                        {t.pr_url && <a href={t.pr_url} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost"><ExternalLink size={12} />PR</Button></a>}
                        {t.status === "in_review" && <Button size="sm" onClick={() => confirm(`Squash-merge PR #${t.pr_number}?`) && wrap(() => api(`/api/tasks/${t.id}/merge`, "POST", {}))}><GitMerge size={12} />Merge</Button>}
                        {t.status === "working" && <Button size="sm" variant="outline" onClick={() => wrap(() => api(`/api/tasks/${t.id}/stop`, "POST", {}))}><Square size={12} />Stop</Button>}
                        {t.source === "local" && <Button size="sm" variant="ghost" onClick={() => setForm({ id: t.id, title: t.title, body: t.body, type: t.type === "code" ? "code" : "manual", project_id: t.project_id ?? "", priority: t.priority?.toString() ?? "" })}><Pencil size={12} />Edit</Button>}
                        {t.type === "manual" && t.status !== "done" && <Button size="sm" onClick={() => wrap(() => api(`/api/tasks/${t.id}/complete`, "POST", {}))}><Check size={12} />Done</Button>}
                        {t.type === "manual" && t.status === "done" && <Button size="sm" variant="outline" onClick={() => wrap(() => api(`/api/tasks/${t.id}/complete`, "POST", { done: false }))}><Undo2 size={12} />Reopen</Button>}
                        {t.type !== "manual" && (t.status === "failed" || t.status === "queued") && <Button size="sm" variant="outline" onClick={() => wrap(() => api(`/api/tasks/${t.id}/retry`, "POST", {}))}><RotateCw size={12} />Retry</Button>}
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
      <Dialog open={!!form} onClose={() => setForm(null)} title={form?.id ? "Edit task" : "New local task"}>
        {form && (
          <div className="grid gap-3">
            <div className="text-xs text-muted-foreground">Local tasks are saved as markdown in your workspace repo. Manual tasks are to-dos for you; local code tasks wait until agents can run them (M8). For a GitHub Issue use Projects, then Task.</div>
            <div><Label>Title</Label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div><Label>Notes</Label><Textarea rows={5} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
            <div className="grid grid-cols-3 gap-2">
              <div><Label>Type</Label><Select disabled={!!form.id} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as TaskForm["type"] })}><option value="manual">manual</option><option value="code">code</option></Select></div>
              <div><Label>Project</Label><Select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}><option value="">none (loose)</option>{state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
              <div><Label>Priority</Label><Input type="number" min={0} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} /></div>
            </div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setForm(null)}>Cancel</Button><Button disabled={!form.title.trim()} onClick={() => wrap(async () => {
              const body = { title: form.title, body: form.body, project_id: form.project_id || null, priority: form.priority === "" ? null : Number(form.priority) };
              if (form.id) await api(`/api/tasks/${form.id}`, "PUT", body);
              else await api("/api/tasks", "POST", { ...body, source: "local", type: form.type });
              setForm(null);
            })}>{form.id ? "Save" : "Create"}</Button></div>
          </div>
        )}
      </Dialog>
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
