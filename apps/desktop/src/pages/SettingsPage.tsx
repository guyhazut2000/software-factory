import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { Badge, Card, Input, Label, Select, Switch } from "../components/ui";

export function SettingsPage() {
  const { state, refresh, toast } = useStore();
  if (!state) return null;
  const s = state.settings;
  const put = (patch: Record<string, unknown>) => api("/api/settings", "PUT", patch).then(refresh).catch((e) => toast(String(e.message)));
  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <Card className="grid gap-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Mode</Label><Select value={s.mode} onChange={(e) => put({ mode: e.target.value })}><option value="quiet">quiet: nothing runs</option><option value="eco">eco: one agent at a time</option><option value="full">full: up to the cap</option></Select></div>
          <div><Label hint="(max agents running at once)">Concurrency cap</Label><Input type="number" min={1} value={s.cap} onChange={(e) => put({ cap: Math.max(1, Number(e.target.value)) })} /></div>
        </div>
        <div>
          <Label>Runner</Label>
          <Select value={s.runner} onChange={(e) => put({ runner: e.target.value })}><option value="sbx">Docker Sandboxes (sbx), isolated, recommended</option><option value="worktree">Git worktree on this machine, NOT isolated</option></Select>
          {s.runner === "worktree" && (
            <div className="mt-2 rounded-md border border-danger/50 bg-danger/10 p-3 text-xs">
              <div className="mb-2 font-medium text-danger">Warning: agents run directly on your computer with your user's permissions, only guarded by hooks.</div>
              <label className="flex items-center gap-2"><Switch checked={s.allow_worktree} onChange={(v) => put({ allow_worktree: v })} />I understand the risk; allow the unsafe fallback</label>
            </div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div><Label hint="(minutes of silence)">Stuck timeout</Label><Input type="number" min={1} value={s.stuck_minutes} onChange={(e) => put({ stuck_minutes: Number(e.target.value) })} /></div>
          <div><Label>Max restarts per task</Label><Input type="number" min={0} value={s.max_restarts} onChange={(e) => put({ max_restarts: Number(e.target.value) })} /></div>
          <div><Label>Review fix rounds</Label><Input type="number" min={0} value={s.max_review_rounds} onChange={(e) => put({ max_review_rounds: Number(e.target.value) })} /></div>
        </div>
        <div><Label hint="(how a sandbox reaches this app)">Host name inside sandboxes</Label><Input value={s.agent_host} onChange={(e) => put({ agent_host: e.target.value })} /><div className="mt-1 text-xs text-muted-foreground">Default <code>host.docker.internal</code>. Unverified for every sbx version: if agents cannot call the factory tools, change it.</div></div>
      </Card>
      <Card className="p-4 text-xs text-muted-foreground"><Badge tone="muted">info</Badge> Merging always needs your click. Agents never push to main (blocked by hooks and the PR flow).</Card>
    </div>
  );
}
