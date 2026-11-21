import { useState } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { Badge, Button, Card, Dialog, Input, Label, Select, StateDot, Switch, Textarea } from "../components/ui";
import type { Agent } from "../lib/types";

const MODELS: Record<string, string[]> = { "claude-code": ["sonnet", "opus", "haiku"], codex: ["gpt-5-codex", "gpt-5"], cursor: ["auto", "sonnet-4.5", "gpt-5"] };
const PERMS = ["advise", "open_pr", "review", "merge", "create_issue"];
const SKILLS = ["implement-issue", "write-tests", "plan-feature", "code-review", "security-review"];
const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

const blank = (): Partial<Agent> => ({ name: "", role: "developer", description: "", provider: "claude-code", model: "sonnet", effort: "medium", context: {}, permissions: ["open_pr"], token_budget: null, max_runtime_sec: 1800, cpu: 2, ram_mb: 4096, skills: [], mcp: {} });

export function Agents() {
  const { state, refresh, toast } = useStore();
  const [edit, setEdit] = useState<Partial<Agent> | null>(null);
  if (!state) return null;
  const wrap = (fn: () => Promise<unknown>) => fn().then(refresh).catch((e) => toast(String(e.message ?? e)));
  const save = () => wrap(async () => { if (edit?.id) await api(`/api/agents/${edit.id}`, "PUT", edit); else await api("/api/agents", "POST", edit); setEdit(null); });
  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => setEdit((e) => ({ ...e, [k]: v }));

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
              <div className="flex items-center gap-2 font-medium">{a.name}<Badge>{a.role}</Badge><span className="text-xs font-normal text-muted-foreground">{a.state.replace(/_/g, " ")}</span></div>
              <div className="truncate text-xs text-muted-foreground">{a.provider} / {a.model} / {a.effort} / perms: {a.permissions.join(", ") || "none"} / skills: {a.skills.join(", ") || "role defaults"}</div>
            </div>
            <Switch checked={a.enabled} onChange={(on) => wrap(() => api(`/api/agents/${a.id}/toggle`, "POST", { on }))} />
            <Button size="icon" variant="ghost" title="Edit" onClick={() => setEdit(a)}><Pencil size={14} /></Button>
            <Button size="icon" variant="ghost" title="Clone" onClick={() => wrap(() => api(`/api/agents/${a.id}/clone`, "POST", {}))}><Copy size={14} /></Button>
            <Button size="icon" variant="ghost" title="Delete" onClick={() => confirm(`Delete ${a.name}?`) && wrap(() => api(`/api/agents/${a.id}`, "DELETE"))}><Trash2 size={14} /></Button>
          </Card>
        ))}
        {state.agents.length === 0 && <Card className="p-6 text-center text-muted-foreground">No agents yet. Start with the Chief, Dev and Reviewer templates above.</Card>}
      </div>

      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : "New agent"} wide>
        {edit && (
          <div className="grid gap-3">
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Name</Label><Input value={edit.name ?? ""} onChange={(e) => set("name", e.target.value)} /></div>
              <div><Label>Role</Label><Input list="roles" value={edit.role ?? ""} onChange={(e) => set("role", e.target.value)} /><datalist id="roles"><option>chief</option><option>developer</option><option>reviewer</option></datalist></div>
              <div><Label>Effort</Label><Select value={edit.effort} onChange={(e) => set("effort", e.target.value)}><option>low</option><option>medium</option><option>high</option></Select></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Provider</Label><Select value={edit.provider} onChange={(e) => { set("provider", e.target.value); set("model", MODELS[e.target.value][0]); }}><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="cursor">Cursor Agent</option></Select></div>
              <div className="col-span-2"><Label hint="(run the CLI's model list to see valid names)">Model</Label><Input list="models" value={edit.model ?? ""} onChange={(e) => set("model", e.target.value)} /><datalist id="models">{(MODELS[edit.provider ?? "claude-code"] ?? []).map((m) => <option key={m}>{m}</option>)}</datalist></div>
            </div>
            <div><Label hint="(becomes the system prompt)">Description</Label><Textarea rows={4} value={edit.description ?? ""} onChange={(e) => set("description", e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label hint="(comma separated)">Instruction files</Label><Input placeholder="AGENTS.md, CLAUDE.md" value={(edit.context?.files ?? []).join(", ")} onChange={(e) => set("context", { ...edit.context, files: csv(e.target.value) })} /></div>
              <div><Label hint="(comma separated, empty = whole repo)">Allowed paths</Label><Input placeholder="src/, tests/" value={(edit.context?.allowed_paths ?? []).join(", ")} onChange={(e) => set("context", { ...edit.context, allowed_paths: csv(e.target.value) })} /></div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div><Label>History size</Label><Input type="number" value={edit.context?.history_size ?? 12} onChange={(e) => set("context", { ...edit.context, history_size: Number(e.target.value) })} /></div>
              <div><Label hint="(tokens/day)">Token budget</Label><Input type="number" placeholder="unlimited" value={edit.token_budget ?? ""} onChange={(e) => set("token_budget", e.target.value ? Number(e.target.value) : null)} /></div>
              <div><Label>Max runtime (s)</Label><Input type="number" value={edit.max_runtime_sec ?? 1800} onChange={(e) => set("max_runtime_sec", Number(e.target.value))} /></div>
              <div className="grid grid-cols-2 gap-2"><div><Label>CPU</Label><Input type="number" value={edit.cpu ?? 2} onChange={(e) => set("cpu", Number(e.target.value))} /></div><div><Label>RAM MB</Label><Input type="number" value={edit.ram_mb ?? 4096} onChange={(e) => set("ram_mb", Number(e.target.value))} /></div></div>
            </div>
            <div>
              <Label>Permissions</Label>
              <div className="flex flex-wrap gap-3">{PERMS.map((p) => <label key={p} className="flex cursor-pointer items-center gap-1.5 text-sm"><input type="checkbox" checked={edit.permissions?.includes(p) ?? false} onChange={(e) => set("permissions", e.target.checked ? [...(edit.permissions ?? []), p] : (edit.permissions ?? []).filter((x) => x !== p))} />{p}</label>)}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label hint="(comma separated, added to role defaults)">Skills / tags</Label><Input list="skills" value={(edit.skills ?? []).join(", ")} onChange={(e) => set("skills", csv(e.target.value))} /><datalist id="skills">{SKILLS.map((s) => <option key={s}>{s}</option>)}</datalist></div>
              <div><Label hint="(factory MCP is always on; extra servers cost tokens)">MCP servers</Label>
                <div className="flex gap-4 pt-2 text-sm">
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!edit.mcp?.github} onChange={(e) => set("mcp", { ...edit.mcp, github: e.target.checked })} />GitHub</label>
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!edit.mcp?.filesystem} onChange={(e) => set("mcp", { ...edit.mcp, filesystem: e.target.checked })} />Filesystem</label>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} disabled={!edit.name}>Save</Button></div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
