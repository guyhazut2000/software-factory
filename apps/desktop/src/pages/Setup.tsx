import { useEffect, useState } from "react";
import { Check, Copy, AlertTriangle, XCircle, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Badge, Button, Card } from "../components/ui";
import { osKey } from "../lib/utils";
import type { Check as C } from "../lib/types";

function Cmd({ cmd }: { cmd: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
      <span className="flex-1 break-all">{cmd}</span>
      <button className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => { navigator.clipboard.writeText(cmd); setDone(true); setTimeout(() => setDone(false), 1200); }}>{done ? <Check size={14} /> : <Copy size={14} />}</button>
    </div>
  );
}

export function Setup() {
  const { toast } = useStore();
  const [checks, setChecks] = useState<C[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => { setBusy(true); api<C[]>("/api/health").then(setChecks).catch((e) => toast(String(e.message))).finally(() => setBusy(false)); };
  useEffect(load, []);
  const os = osKey();
  const icon = (s: C["status"]) => (s === "ok" ? <Check size={16} className="text-ok" /> : s === "warn" ? <AlertTriangle size={16} className="text-warn" /> : <XCircle size={16} className="text-danger" />);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-center gap-2"><h1 className="text-lg font-semibold">Setup and health</h1>
        <span className="text-muted-foreground">The app works without these; agents need what they use.</span>
        <Button className="ml-auto" variant="outline" size="sm" onClick={load} disabled={busy}><RefreshCw size={13} className={busy ? "animate-spin" : ""} />Re-check</Button></div>
      <div className="grid gap-2">
        {(checks ?? []).map((c) => (
          <Card key={c.id} className="p-3">
            <div className="flex items-center gap-2">{icon(c.status)}<span className="font-medium">{c.label}</span>{c.required && <Badge tone="primary">required</Badge>}<span className="ml-auto truncate text-xs text-muted-foreground">{c.detail}</span></div>
            {c.status !== "ok" && c.install && <div className="mt-2 text-xs"><span className="text-muted-foreground">Install ({os}):</span><Cmd cmd={c.install[os]} /></div>}
            {c.status !== "ok" && c.login && <div className="mt-2 text-xs"><span className="text-muted-foreground">Then:</span><Cmd cmd={c.login} /></div>}
            {c.id === "sbx-policy" && <Button size="sm" className="mt-2" onClick={() => api<string[]>("/api/sbx/policy", "POST", {}).then((l) => { toast(l.join("\n").slice(0, 300)); load(); })}>Apply default policy (GitHub + providers)</Button>}
          </Card>
        ))}
      </div>
      <Card className="mt-4 p-3 text-xs text-muted-foreground">No sbx yet? In Settings, switch the runner to "worktree" and accept the warning to test agents directly on this machine without isolation.</Card>
    </div>
  );
}
