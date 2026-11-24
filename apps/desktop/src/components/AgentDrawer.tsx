import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ExternalLink, FileDiff, Power, RotateCcw, Square, X } from "lucide-react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { ago, cn, fmtTokens } from "../lib/utils";
import { activityQuery, type Activity } from "../lib/activity";
import { agentLogs, agentMessages, loadAgentMessages, clampWidth, recreateHint, DRAWER_TABS, onOpenAgent, taskWorkspace, type DrawerTab } from "../lib/drawer";
import type { Agent, Message } from "../lib/types";
import { Badge, Button, StateDot } from "./ui";
import { AgentForm } from "./AgentForm";
import { TerminalPanel } from "../ide/Terminal";

const Ide = lazy(() => import("../pages/Ide"));
const LABEL: Record<DrawerTab, string> = { overview: "Overview", settings: "Settings", terminal: "Terminal", files: "Files", diff: "Diff", messages: "Messages", log: "Log" };
const Empty = ({ children }: { children: string }) => <div className="p-6 text-center text-sm text-muted-foreground">{children}</div>;

/** Agent workspace drawer (docs/PHASE2.md 2.7b): one resizable panel per agent, reusing the IDE, terminal and log views. */
export function AgentDrawer({ gotoIde }: { gotoIde: (wid: string) => void }) {
  const { state, logs, activityTick, refresh, toast } = useStore();
  const [target, setTarget] = useState<{ id: string; tab: DrawerTab } | null>(null);
  const [width, setWidth] = useState(() => clampWidth(Number(localStorage.getItem("sf-drawer-w")) || 720, window.innerWidth));
  const [act, setAct] = useState<Activity>({ live: [], history: [] });
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [edit, setEdit] = useState<Partial<Agent> | null>(null);
  const drag = useRef(false);

  useEffect(() => onOpenAgent(setTarget), []);
  useEffect(() => { setEdit(null); }, [target?.id]);
  useEffect(() => {
    if (!target) return;
    api<Activity>(activityQuery({ agent: target.id, limit: 5 })).then(setAct).catch(() => setAct({ live: [], history: [] }));
  }, [target, activityTick]);
  useEffect(() => {
    if (target?.tab !== "messages") return;
    const load = () => loadAgentMessages(target.id).then(setMsgs).catch((e) => toast(String(e.message ?? e)));
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [target, activityTick, toast]);
  useEffect(() => {
    const move = (e: MouseEvent) => { if (drag.current) setWidth(clampWidth(window.innerWidth - e.clientX, window.innerWidth)); };
    const up = () => { if (drag.current) { drag.current = false; document.body.style.userSelect = ""; } };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);
  useEffect(() => { localStorage.setItem("sf-drawer-w", String(width)); }, [width]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && target?.tab !== "terminal") setTarget(null); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [target]);

  const agent = state?.agents.find((a) => a.id === target?.id);
  if (!state || !target || !agent) return null;
  const live = act.live[0] ?? null;
  const last = live ?? act.history[0] ?? null;
  const taskId = live?.task_id ?? agent.current_task_id ?? last?.task_id ?? null;
  const task = state.tasks.find((t) => t.id === taskId);
  const wid = taskWorkspace(taskId);
  const running = state.running.some((r) => r.agent_id === agent.id);
  const wrap = (fn: () => Promise<unknown>) => fn().then(refresh).catch((e) => toast(String(e.message ?? e)));
  const tab = target.tab;
  const kv = (k: string, v: React.ReactNode) => <><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 truncate">{v ?? "-"}</dd></>;

  const body = () => {
    switch (tab) {
      case "overview": return (
        <div className="grid gap-4 p-4 text-sm">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
            {kv("State", <span className="flex items-center gap-2"><StateDot state={agent.state} />{agent.state.replace(/_/g, " ")}</span>)}
            {kv("Task", task ? task.title : last?.task)}
            {kv("Branch", <span className="font-mono text-xs">{task?.branch ?? last?.branch ?? "-"}</span>)}
            {kv("PR", (task?.pr_url ?? last?.pr_url) ? <a className="inline-flex items-center gap-1 text-primary" href={(task?.pr_url ?? last?.pr_url)!} target="_blank" rel="noreferrer">#{task?.pr_number ?? last?.pr}<ExternalLink size={11} /></a> : "-")}
            {kv("Runner", live ? `${live.runner ?? "-"}${live.sandbox_name ? ` (${live.sandbox_name})` : ""}` : "-")}
            {kv("Heartbeat", live?.last_heartbeat_at ? `${ago(live.last_heartbeat_at)} ago` : running ? "no heartbeat" : "not running")}
            {kv("Tokens", `${fmtTokens(live?.tokens ?? 0)} this run / ${fmtTokens(agent.tokens_today)} today`)}
            {kv("Model", `${agent.provider} / ${agent.model} / ${agent.effort}`)}
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => wrap(() => api(`/api/agents/${agent.id}/toggle`, "POST", { on: !agent.enabled }))}><Power size={13} />{agent.enabled ? "Turn off" : "Turn on"}</Button>
            <Button size="sm" variant="outline" onClick={() => wrap(() => api(`/api/agents/${agent.id}/restart`, "POST", {}))}><RotateCcw size={13} />Restart</Button>
            <Button size="sm" variant="danger" disabled={!running || !taskId} onClick={() => confirm(`Stop ${agent.name}'s current task?`) && wrap(() => api(`/api/tasks/${taskId}/stop`, "POST", {}))}><Square size={13} />Stop</Button>
            {wid && <Button size="sm" variant="outline" onClick={() => gotoIde(wid)}><FileDiff size={13} />Open task diff in IDE</Button>}
          </div>
        </div>
      );
      case "settings": {
        const v = edit ?? agent;
        return (
          <div className="grid gap-4 p-4">
            <AgentForm value={v} onChange={setEdit} onCancel={() => setEdit(null)} onSave={() => wrap(async () => { await api(`/api/agents/${agent.id}`, "PUT", v); setEdit(null); })} />
            <div className="flex items-center gap-3 rounded-md border p-3 text-sm">
              <div className="flex-1 text-muted-foreground">{recreateHint(agent)}</div>
              <Button size="sm" variant="outline" disabled={!agent.current_task_id} onClick={() => confirm(`Recreate ${agent.name}'s sandbox with ${agent.cpu} CPU / ${agent.ram_mb} MB?`) && wrap(() => api(`/api/agents/${agent.id}/recreate-sandbox`, "POST", {}))}><RotateCcw size={13} />Recreate sandbox</Button>
            </div>
          </div>
        );
      }
      case "terminal": return running ? <div className="h-full p-2"><TerminalPanel key={agent.id} agent={{ id: agent.id, name: agent.name }} onClose={() => setTarget({ ...target, tab: "overview" })} /></div> : <Empty>The agent has no live workspace (not running).</Empty>;
      case "files":
      case "diff":
        if (!wid) return <Empty>No task workspace yet: the agent has no current task.</Empty>;
        return (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
              {tab === "diff" ? "Open Source control in the IDE below to see the task branch vs base." : "Read-only while the agent holds the lease."}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => gotoIde(wid)}><ExternalLink size={12} />Open in IDE tab</Button>
            </div>
            <div className="min-h-0 flex-1"><Suspense fallback={<Empty>Loading the editor...</Empty>}><Ide key={wid} initial={wid} /></Suspense></div>
          </div>
        );
      case "messages": {
        const own = agentMessages(msgs, agent.id);
        const send = () => draft.trim() && wrap(async () => {
          const r = await api<{ queued: boolean }>("/api/threads/direct", "POST", { agent_id: agent.id, project_id: state.tasks.find((t) => t.id === agent.current_task_id)?.project_id ?? null, text: draft.trim() });
          setDraft("");
          if (r.queued) toast(`${agent.name} is busy: note queued for its next turn`);
          setMsgs(await loadAgentMessages(agent.id));
        });
        return <div className="flex h-full flex-col"><div className="min-h-0 flex-1 overflow-auto">{!own.length ? <Empty>No messages yet.</Empty> : <div className="grid gap-2 p-3 text-sm">{own.map((m) => <div key={m.id} className={cn("rounded-md border p-2", m.from_id === agent.id ? "bg-muted/50" : "")}><div className="mb-0.5 text-xs text-muted-foreground">{m.from_id === agent.id ? "sent" : `from ${state.agents.find((a) => a.id === m.from_id)?.name ?? m.from_id ?? "Guy"}`} · {ago(m.created_at)} ago</div><div className="whitespace-pre-wrap break-words">{m.body}</div></div>)}</div>}</div>
          <form className="flex gap-2 border-t p-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input aria-label={`Message ${agent.name}`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Ask ${agent.name} (read-only advice; changes go through a task)`} className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm" />
            <Button size="sm" type="submit" disabled={!draft.trim()}>Send</Button>
          </form>
        </div>;
      }
      case "log": {
        const own = agentLogs(logs, agent.id);
        return <div className="p-2 font-mono text-[11px]">{own.map((l, i) => <div key={i} className="whitespace-pre-wrap break-words"><span className="text-muted-foreground">{new Date(l.ts).toLocaleTimeString()} {l.kind} </span>{l.text}</div>)}{!own.length && <div className="p-4 text-muted-foreground">No log yet.</div>}</div>;
      }
    }
  };

  return (
    <aside role="dialog" aria-label={`${agent.name} drawer`} style={{ width }} className="fixed bottom-0 right-0 top-0 z-50 flex flex-col border-l bg-card shadow-2xl">
      <div onMouseDown={() => { drag.current = true; document.body.style.userSelect = "none"; }} className="absolute bottom-0 left-0 top-0 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40" title="Drag to resize" />
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <StateDot state={agent.state} /><span className="font-semibold">{agent.name}</span><Badge>{agent.role}</Badge>
        {!agent.enabled && <Badge tone="warn">off</Badge>}
        <Button size="icon" variant="ghost" className="ml-auto" title="Close" onClick={() => setTarget(null)}><X size={16} /></Button>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-b px-2">
        {DRAWER_TABS.map((t) => <button key={t} onClick={() => setTarget({ ...target, tab: t })} className={cn("cursor-pointer whitespace-nowrap border-b-2 px-2.5 py-1.5 text-sm", tab === t ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>{LABEL[t]}</button>)}
      </nav>
      <div className={cn("min-h-0 flex-1", tab === "files" || tab === "diff" || tab === "terminal" ? "overflow-hidden" : "overflow-auto")}>{body()}</div>
    </aside>
  );
}
