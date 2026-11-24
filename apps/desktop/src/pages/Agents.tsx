import { useState } from "react";
import { Copy, Pencil, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { Badge, Button, Card, Dialog, StateDot, Switch } from "../components/ui";
import type { Agent } from "../lib/types";
import { TerminalPanel } from "../ide/Terminal";
import { AgentForm } from "../components/AgentForm";
import { openAgent } from "../lib/drawer";


const blank = (): Partial<Agent> => ({ name: "", role: "developer", description: "", provider: "claude-code", model: "sonnet", effort: "medium", context: {}, permissions: ["open_pr"], token_budget: null, max_runtime_sec: 1800, cpu: 2, ram_mb: 4096, skills: [], mcp: {} });

export function Agents() {
  const { state, refresh, toast } = useStore();
  const [edit, setEdit] = useState<Partial<Agent> | null>(null);
  const [term, setTerm] = useState<Agent | null>(null);
  if (!state) return null;
  const wrap = (fn: () => Promise<unknown>) => fn().then(refresh).catch((e) => toast(String(e.message ?? e)));
  const save = () => wrap(async () => { if (edit?.id) await api(`/api/agents/${edit.id}`, "PUT", edit); else await api("/api/agents", "POST", edit); setEdit(null); });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Agents</h1>
        <span className="text-muted-foreground">Add as many as you like. Each has its own model, role and limits.</span>
        <div className="ml-auto flex gap-2">
          {state.templates.map((t) => <Button key={t.key} variant="outline" size="sm" onClick={() => wrap(() => api("/api/agents", "POST", { template: t.key }))}><Plus size={13} />{t.name}</Button>)}
          <Button size="sm" onClick={() => setEdit(blank())}><Plus size={13} />Custom</Button>
        </div>
      </div>
      <div className="grid gap-3">
        {state.agents.map((a) => (
          <Card key={a.id} className="flex items-center gap-3 p-3">
            <StateDot state={a.state} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-medium"><button className="cursor-pointer hover:underline" title="Open the agent drawer" onClick={() => openAgent(a.id)}>{a.name}</button><Badge>{a.role}</Badge><span className="text-xs font-normal text-muted-foreground">{a.state.replace(/_/g, " ")}</span></div>
              <div className="truncate text-xs text-muted-foreground">{a.provider} / {a.model} / {a.effort} / perms: {a.permissions.join(", ") || "none"} / skills: {a.skills.join(", ") || "role defaults"}</div>
            </div>
            <Switch checked={a.enabled} onChange={(on) => wrap(() => api(`/api/agents/${a.id}/toggle`, "POST", { on }))} />
            {(() => {
              const live = state.running.some((r) => r.agent_id === a.id);
              return <Button size="sm" variant="outline" title={live ? "Open a shell in this agent's sandbox / worktree" : "The agent has no live workspace (not running)"} disabled={!live} onClick={() => setTerm(a)}><SquareTerminal size={13} />Terminal</Button>;
            })()}
            <Button size="icon" variant="ghost" title="Edit" onClick={() => setEdit(a)}><Pencil size={14} /></Button>
            <Button size="icon" variant="ghost" title="Clone" onClick={() => wrap(() => api(`/api/agents/${a.id}/clone`, "POST", {}))}><Copy size={14} /></Button>
            <Button size="icon" variant="ghost" title="Delete" onClick={() => confirm(`Delete ${a.name}?`) && wrap(() => api(`/api/agents/${a.id}`, "DELETE"))}><Trash2 size={14} /></Button>
          </Card>
        ))}
        {state.agents.length === 0 && <Card className="p-6 text-center text-muted-foreground">No agents yet. Start with the Chief, Dev and Reviewer templates above.</Card>}
      </div>

      <Dialog open={!!term} onClose={() => setTerm(null)} title={term ? `${term.name}: terminal` : ""} wide>
        {term && <div className="h-[60vh] min-h-[240px]"><TerminalPanel key={term.id} agent={{ id: term.id, name: term.name }} onClose={() => setTerm(null)} /></div>}
      </Dialog>

      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : "New agent"} wide>
        {edit && <AgentForm value={edit} onChange={setEdit} onSave={save} onCancel={() => setEdit(null)} />}
      </Dialog>
    </div>
  );
}
