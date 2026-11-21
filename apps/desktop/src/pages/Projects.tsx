import { useEffect, useState } from "react";
import { Github, Lock, Plus, Tags, Trash2 } from "lucide-react";
import { useStore } from "../lib/store";
import { api, inTauri, tauri } from "../lib/api";
import { Badge, Button, Card, Dialog, Input, Label, Select, Textarea } from "../components/ui";
import type { Project } from "../lib/types";

interface Repo { full_name: string; private: boolean; description: string | null }

export function Projects() {
  const { state, refresh, toast } = useStore();
  const [auth, setAuth] = useState<{ connected: boolean; user?: string; source?: string; error?: string } | null>(null);
  const [token, setToken] = useState("");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [q, setQ] = useState("");
  const [create, setCreate] = useState({ name: "", private: true });
  const [editing, setEditing] = useState<Project | null>(null);
  const [newTask, setNewTask] = useState<{ project: Project; title: string; body: string; agent: string } | null>(null);
  const wrap = (fn: () => Promise<unknown>) => fn().then(refresh).catch((e) => toast(String(e.message ?? e)));
  const loadAuth = () => api<typeof auth>("/api/auth").then(setAuth).catch(() => {});
  useEffect(() => { loadAuth(); }, []);
  if (!state) return null;

  const connect = async () => {
    await api("/api/auth/token", "POST", { token });
    if (inTauri()) await tauri("keychain_set", { token }).catch((e) => toast(`Keychain: ${e}`));
    setToken("");
    await loadAuth();
  };
  const link = (repo: string) => wrap(() => api("/api/projects", "POST", { repo }));

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2 font-medium"><Github size={16} />GitHub connection
          {auth?.connected ? <Badge tone="ok">connected as {auth.user} ({auth.source})</Badge> : <Badge tone="danger">not connected</Badge>}</div>
        <div className="text-xs text-muted-foreground">Uses your <code>gh auth login</code> session automatically. Or paste a Personal Access Token (classic: <code>repo</code>, <code>workflow</code>; fine-grained: Contents, Pull requests, Issues, Metadata). {inTauri() ? "It is stored in your OS keychain." : "Keychain storage is available in the desktop app."}</div>
        {auth?.error && <div className="mt-1 text-xs text-danger">{auth.error}</div>}
        <div className="mt-3 flex gap-2"><Input type="password" placeholder="ghp_... or github_pat_..." value={token} onChange={(e) => setToken(e.target.value)} /><Button onClick={connect} disabled={!token}>Connect</Button>
          {inTauri() && <Button variant="outline" onClick={() => wrap(async () => { await tauri("keychain_delete"); await api("/api/auth/token", "POST", { token: null }); await loadAuth(); })}>Forget</Button>}</div>
      </Card>

      <div>
        <div className="mb-2 flex items-center justify-between"><h1 className="text-lg font-semibold">Projects</h1>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => api<Repo[]>("/api/repos").then(setRepos).catch((e) => toast(String(e.message)))}>Browse my repos</Button>
          </div></div>
        <div className="grid gap-2">
          {state.projects.map((p) => (
            <Card key={p.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1"><div className="font-medium">{p.repo}</div><div className="text-xs text-muted-foreground">{state.tasks.filter((t) => t.project_id === p.id).length} tasks / branch {p.default_branch}</div></div>
              <Button size="sm" onClick={() => setNewTask({ project: p, title: "", body: "", agent: "" })}><Plus size={13} />Task</Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(p)}>Instructions</Button>
              <Button size="icon" variant="ghost" title="Create status:* and agent:* labels" onClick={() => wrap(() => api(`/api/projects/${p.id}/labels`, "POST", {}))}><Tags size={14} /></Button>
              <Button size="icon" variant="ghost" title="Unlink" onClick={() => confirm(`Unlink ${p.repo}? (The repo is untouched)`) && wrap(() => api(`/api/projects/${p.id}`, "DELETE"))}><Trash2 size={14} /></Button>
            </Card>
          ))}
          {state.projects.length === 0 && <Card className="p-6 text-center text-muted-foreground">No projects linked yet. Browse your repos or create a new one.</Card>}
        </div>
      </div>

      <Card className="p-4">
        <div className="mb-2 font-medium">Create a new repository</div>
        <div className="flex gap-2"><Input placeholder="my-new-project" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} />
          <label className="flex items-center gap-1.5 whitespace-nowrap text-sm"><input type="checkbox" checked={create.private} onChange={(e) => setCreate({ ...create, private: e.target.checked })} /><Lock size={12} />private</label>
          <Button disabled={!create.name} onClick={() => wrap(async () => { await api("/api/projects", "POST", { create }); setCreate({ ...create, name: "" }); })}>Create and link</Button></div>
      </Card>

      <Dialog open={!!repos} onClose={() => setRepos(null)} title="Link an existing repository">
        <Input placeholder="Filter..." value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="mt-3 max-h-80 overflow-auto">
          {(repos ?? []).filter((r) => r.full_name.toLowerCase().includes(q.toLowerCase())).map((r) => {
            const linked = state.projects.some((p) => p.repo === r.full_name);
            return <div key={r.full_name} className="flex items-center gap-2 border-b py-2"><div className="min-w-0 flex-1"><div className="truncate">{r.full_name} {r.private && <Lock size={11} className="inline" />}</div><div className="truncate text-xs text-muted-foreground">{r.description}</div></div><Button size="sm" disabled={linked} onClick={() => link(r.full_name)}>{linked ? "Linked" : "Link"}</Button></div>;
          })}
        </div>
      </Dialog>

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={`Instructions: ${editing?.repo}`} wide>
        <div className="mb-2 text-xs text-muted-foreground">Extra instructions appended to every agent's system prompt for this project (build commands, conventions, no-go areas). Keep it short: it costs tokens on every run.</div>
        <Textarea rows={10} value={editing?.instructions ?? ""} onChange={(e) => setEditing(editing && { ...editing, instructions: e.target.value })} />
        <div className="mt-3 flex justify-end gap-2"><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={() => wrap(async () => { await api(`/api/projects/${editing!.id}`, "PUT", { instructions: editing!.instructions }); setEditing(null); })}>Save</Button></div>
      </Dialog>

      <Dialog open={!!newTask} onClose={() => setNewTask(null)} title={`New task in ${newTask?.project.repo}`}>
        {newTask && (
          <div className="grid gap-3">
            <div className="text-xs text-muted-foreground">Creates a GitHub Issue labelled <code>status:ready</code>; an idle developer agent picks it up. Or just ask the Chief.</div>
            <div><Label>Title</Label><Input value={newTask.title} onChange={(e) => setNewTask({ ...newTask, title: e.target.value })} /></div>
            <div><Label>Description / acceptance criteria</Label><Textarea rows={6} value={newTask.body} onChange={(e) => setNewTask({ ...newTask, body: e.target.value })} /></div>
            <div><Label>Pin to agent (optional)</Label><Select value={newTask.agent} onChange={(e) => setNewTask({ ...newTask, agent: e.target.value })}><option value="">any</option>{state.agents.filter((a) => a.permissions.includes("open_pr")).map((a) => <option key={a.id}>{a.name}</option>)}</Select></div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setNewTask(null)}>Cancel</Button><Button disabled={!newTask.title} onClick={() => wrap(async () => { await api("/api/tasks", "POST", { project_id: newTask.project.id, title: newTask.title, body: newTask.body, agent: newTask.agent || undefined }); setNewTask(null); })}>Create issue</Button></div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
