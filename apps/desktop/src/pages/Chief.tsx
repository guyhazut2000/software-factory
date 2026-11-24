import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { Button, Card, Input, Select, Textarea } from "../components/ui";
import type { Message } from "../lib/types";
import { cn } from "../lib/utils";

export function Chief() {
  const { state, refresh, toast, logs } = useStore();
  const [project, setProject] = useState("");
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [bus, setBus] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const end = useRef<HTMLDivElement>(null);
  const pid = project || state?.projects[0]?.id || "";
  const load = () => {
    api<Message[]>(`/api/messages?channel=chat&project_id=${pid}`).then(setMsgs).catch(() => {});
    api<Message[]>("/api/bus").then(setBus).catch(() => {});
  };
  useEffect(load, [pid, logs.length, state?.questions.length]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length]);
  if (!state) return null;
  const chief = state.agents.find((a) => a.role === "chief");
  const name = (id: string | null) => (id === null ? "You" : state.agents.find((a) => a.id === id)?.name ?? "system");
  const busy = chief?.state === "working";
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    api("/api/chat", "POST", { project_id: pid || null, text: t }).then(() => setTimeout(load, 200)).catch((e) => toast(String(e.message)));
  };

  return (
    <div className="mx-auto grid h-full max-w-6xl grid-cols-[2fr_1fr] gap-4">
      <Card className="flex min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="font-medium">Chat with {chief?.name ?? "the Chief"}</span>
          <Select className="ml-auto w-56" value={pid} onChange={(e) => setProject(e.target.value)}>{state.projects.length === 0 && <option value="">no project</option>}{state.projects.map((p) => <option key={p.id} value={p.id}>{p.repo ?? p.name}</option>)}</Select>
        </div>
        <div className="flex-1 space-y-3 overflow-auto p-4">
          {msgs.length === 0 && <div className="text-muted-foreground">Describe what you want built. The Chief splits it into GitHub Issues and the team picks them up. It asks you only when truly blocked.</div>}
          {msgs.map((m) => (
            <div key={m.id} className={cn("max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2", m.from_id === null ? "ml-auto bg-primary text-primary-foreground" : "bg-muted")}>
              <div className="mb-0.5 text-[11px] opacity-70">{name(m.from_id)}</div>{m.body}
            </div>
          ))}
          {busy && <div className="text-xs text-muted-foreground pulse-dot">{chief?.name} is thinking...</div>}
          <div ref={end} />
        </div>
        <div className="flex gap-2 border-t p-3">
          <Textarea rows={2} className="resize-none" placeholder="e.g. Add dark mode to the settings page" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <Button onClick={send} disabled={!text.trim()}><Send size={14} /></Button>
        </div>
      </Card>
      <div className="flex min-h-0 flex-col gap-4">
        <Card className="p-3">
          <div className="mb-2 font-medium">Questions inbox ({state.questions.length})</div>
          {state.questions.length === 0 && <div className="text-xs text-muted-foreground">Nothing waiting for you.</div>}
          {state.questions.map((q) => (
            <div key={q.id} className="mb-3 rounded-lg bg-warn/10 p-2 text-sm">
              <div className="text-[11px] text-muted-foreground">{name(q.agent_id)}{q.task_id ? ` on "${state.tasks.find((t) => t.id === q.task_id)?.title ?? "task"}"` : ""}</div>
              <div className="my-1">{q.body}</div>
              <div className="flex gap-1"><Input value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} placeholder="Your answer" />
                <Button size="sm" disabled={!answers[q.id]} onClick={() => api(`/api/questions/${q.id}/answer`, "POST", { answer: answers[q.id] }).then(() => { setAnswers({ ...answers, [q.id]: "" }); refresh(); load(); }).catch((e) => toast(String(e.message)))}>Send</Button></div>
            </div>
          ))}
        </Card>
        <Card className="flex min-h-0 flex-1 flex-col p-3">
          <div className="mb-2 font-medium">Agent message bus</div>
          <div className="flex-1 space-y-1.5 overflow-auto text-xs">
            {bus.length === 0 && <div className="text-muted-foreground">Agents talk only through here (logged). No messages yet.</div>}
            {bus.map((m) => <div key={m.id}><span className="text-muted-foreground">{name(m.from_id)} to {name(m.to_id)}: </span>{m.body}</div>)}
          </div>
        </Card>
      </div>
    </div>
  );
}
