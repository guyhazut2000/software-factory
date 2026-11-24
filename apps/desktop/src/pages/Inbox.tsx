import { useEffect, useState } from "react";
import { Send, X } from "lucide-react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { Badge, Button, Card, Input, Textarea } from "../components/ui";
import { askOptions, groupAsks, KIND_LABEL, threadLabel } from "../lib/inbox";
import { openAgent } from "../lib/drawer";
import type { Message, Thread } from "../lib/types";
import { cn } from "../lib/utils";

/** One inbox: open asks grouped by agent (answer with buttons or text), plus every thread. */
export function Inbox() {
  const { state, refresh, toast, logs } = useStore();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [threads, setThreads] = useState<Thread[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const loadThreads = () => api<Thread[]>("/api/threads").then(setThreads).catch(() => {});
  const loadMsgs = () => { if (sel) api<Message[]>(`/api/threads/${sel}/messages`).then(setMsgs).catch(() => {}); };
  useEffect(() => { loadThreads(); }, [state?.questions.length]);
  useEffect(loadMsgs, [sel, logs.length, state?.questions.length]);
  if (!state) return null;
  const agentName = (id: string | null) => (id === null ? "You" : state.agents.find((a) => a.id === id)?.name ?? "system");
  const projectName = (id: string | null) => (id ? state.projects.find((p) => p.id === id)?.repo ?? state.projects.find((p) => p.id === id)?.name ?? id : "no project");
  const groups = groupAsks(state.questions, state.agents);
  const fail = (e: Error) => toast(String(e.message));
  const answer = (id: string, a: string) => api(`/api/questions/${id}/answer`, "POST", { answer: a }).then(() => { setAnswers({ ...answers, [id]: "" }); refresh(); loadMsgs(); }).catch(fail);
  const dismiss = (id: string) => api(`/api/questions/${id}/dismiss`, "POST", {}).then(refresh).catch(fail);
  const send = () => {
    const t = text.trim();
    if (!t || !sel) return;
    setText("");
    api(`/api/threads/${sel}/messages`, "POST", { text: t }).then(() => setTimeout(loadMsgs, 200)).catch(fail);
  };
  const thread = threads.find((t) => t.id === sel);

  return (
    <div className="mx-auto grid h-full max-w-6xl grid-cols-[1fr_1fr] gap-4">
      <Card className="min-h-0 overflow-auto p-3">
        <div className="mb-2 font-medium">Action items ({state.questions.length})</div>
        {groups.length === 0 && <div className="text-xs text-muted-foreground">Nothing waiting for you.</div>}
        {groups.map((g) => (
          <div key={g.agent_id} className="mb-4">
            <button className="mb-1 flex cursor-pointer items-center gap-2 text-sm font-medium hover:underline" onClick={() => openAgent(g.agent_id, "messages")}>{g.name}<Badge tone="warn">{g.asks.length}</Badge></button>
            {g.asks.map((q) => {
              const opts = askOptions(q);
              return (
                <div key={q.id} className="mb-2 rounded-lg bg-warn/10 p-2 text-sm" data-testid="ask">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Badge>{KIND_LABEL[q.kind ?? "question"] ?? q.kind}</Badge>
                    {q.task_id ? `on "${state.tasks.find((t) => t.id === q.task_id)?.title ?? "task"}"` : projectName(q.project_id)}
                    <button className="ml-auto cursor-pointer hover:text-foreground" title="Dismiss" onClick={() => dismiss(q.id)}><X size={13} /></button>
                  </div>
                  <div className="my-1 whitespace-pre-wrap">{q.body}</div>
                  {q.kind === "credential" && <div className="mb-1 text-[11px] text-muted-foreground">Store the secret in your environment or Settings; answer here only with where you put it, never the value.</div>}
                  {opts.length > 0 && <div className="mb-1 flex flex-wrap gap-1">{opts.map((o) => <Button key={o} size="sm" variant="outline" onClick={() => answer(q.id, o)}>{o}</Button>)}</div>}
                  <div className="flex gap-1"><Input value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} placeholder={q.kind === "action" ? "Done? Add a note" : "Your answer"} />
                    <Button size="sm" disabled={!answers[q.id]} onClick={() => answer(q.id, answers[q.id])}>Send</Button></div>
                </div>
              );
            })}
          </div>
        ))}
      </Card>
      <Card className="flex min-h-0 flex-col">
        <div className="max-h-48 overflow-auto border-b p-2">
          <div className="mb-1 px-1 font-medium">Threads ({threads.length})</div>
          {threads.map((t) => (
            <button key={t.id} onClick={() => setSel(t.id)} className={cn("block w-full cursor-pointer truncate rounded px-2 py-1 text-left text-sm", sel === t.id ? "bg-muted font-medium" : "hover:bg-muted/60")}>{threadLabel(t, agentName, projectName)}</button>
          ))}
        </div>
        <div className="flex-1 space-y-2 overflow-auto p-3">
          {!thread && <div className="text-xs text-muted-foreground">Pick a thread to read it.</div>}
          {thread && msgs.map((m) => (
            <div key={m.id} className={cn("max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm", m.from_id === null ? "ml-auto bg-primary text-primary-foreground" : "bg-muted")}>
              <div className="mb-0.5 text-[11px] opacity-70">{agentName(m.from_id)}</div>{m.body}
            </div>
          ))}
        </div>
        {thread && thread.kind !== "ask" && (
          <div className="flex gap-2 border-t p-3">
            <Textarea rows={2} className="resize-none" placeholder={thread.kind === "direct" ? "Ask for advice (read-only)" : "Message the Chief"} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <Button onClick={send} disabled={!text.trim()}><Send size={14} /></Button>
          </div>
        )}
      </Card>
    </div>
  );
}
