import { Suspense, lazy, useEffect, useState } from "react";
import { Activity, Bot, Code2, Coins, FolderGit2, HeartPulse, MessageSquare, Moon, OctagonX, Play, Settings as Cog, Sun } from "lucide-react";
import { useStore } from "./lib/store";
import { api } from "./lib/api";
import { Badge, Button, Select } from "./components/ui";
import { cn } from "./lib/utils";
import { Dashboard } from "./pages/Dashboard";
import { Agents } from "./pages/Agents";
import { Projects } from "./pages/Projects";
import { Chief } from "./pages/Chief";
import { Costs } from "./pages/Costs";
import { Setup } from "./pages/Setup";
import { SettingsPage } from "./pages/SettingsPage";

// Monaco is heavy: load the IDE (and the editor) only when the tab is opened.
const Ide = lazy(() => import("./pages/Ide"));

const TABS = [
  { id: "dashboard", label: "Dashboard", icon: Activity },
  { id: "chief", label: "Chief", icon: MessageSquare },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "ide", label: "IDE", icon: Code2 },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "costs", label: "Costs", icon: Coins },
  { id: "setup", label: "Setup", icon: HeartPulse },
  { id: "settings", label: "Settings", icon: Cog },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function App() {
  const { state, connected, error, toasts, toast, refresh } = useStore();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [ideWs, setIdeWs] = useState<string | undefined>();
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("sf-theme", dark ? "dark" : "light");
  }, [dark]);
  const wrap = (fn: () => Promise<unknown>) => fn().then(refresh).catch((e) => toast(String(e.message ?? e)));

  if (!state)
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div className="mb-2 text-lg font-semibold text-foreground">Software Factory</div>
          {error?.includes("TOKEN_MISMATCH") ? (
            <div className="max-w-md text-danger">Token mismatch: this page and the running orchestrator disagree on the API token (often a stale orchestrator process, or a token with a trailing space). Stop every node process for Software Factory and run <code>pnpm start</code> again; do not set SF_API_TOKEN by hand.</div>
          ) : (
            <><div>{error ? `Starting the orchestrator... (${error})` : "Connecting..."}</div>
            <div className="mt-3 text-xs">If this never goes away, see Troubleshooting in the README.</div></>
          )}
        </div>
      </div>
    );

  const s = state.settings;
  const q = state.questions.length;
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b bg-card px-4 py-2">
        <div className="mr-2 flex items-center gap-2 font-semibold"><span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-xs text-primary-foreground">SF</span>Software Factory</div>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={cn("flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm", tab === t.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60")}>
              <t.icon size={15} />{t.label}
              {t.id === "chief" && q > 0 && <Badge tone="warn">{q}</Badge>}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {s.runner === "worktree" && <Badge tone="danger" title="Agents run on your machine without isolation">unsafe: no sandbox</Badge>}
          <span className="text-xs text-muted-foreground">Mode</span>
          <Select className="h-8 w-24" value={s.mode} onChange={(e) => wrap(() => api("/api/settings", "PUT", { mode: e.target.value }))}>
            <option value="quiet">quiet</option><option value="eco">eco (1)</option><option value="full">full ({s.cap})</option>
          </Select>
          {s.stopped
            ? <Button size="sm" onClick={() => wrap(() => api("/api/resume", "POST", {}))}><Play size={14} />Resume</Button>
            : <Button size="sm" variant="danger" onClick={() => wrap(() => api("/api/stop-all", "POST", {}))}><OctagonX size={14} />Stop all</Button>}
          <Button size="icon" variant="ghost" onClick={() => setDark(!dark)} title="Theme">{dark ? <Sun size={16} /> : <Moon size={16} />}</Button>
          <span title={connected ? "live" : "reconnecting"} className={cn("h-2 w-2 rounded-full", connected ? "bg-ok" : "bg-warn pulse-dot")} />
        </div>
      </header>
      {s.stopped && <div className="bg-danger/15 px-4 py-1.5 text-center text-xs text-danger">Factory stopped. No agent will start until you press Resume.</div>}
      <main className={cn("min-h-0 flex-1 p-4", tab === "ide" ? "overflow-hidden" : "overflow-auto")}>
        {tab === "dashboard" && <Dashboard goto={(t, arg) => { if (t === "ide") setIdeWs(arg); setTab(t as Tab); }} />}
        {tab === "ide" && <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading the editor...</div>}><Ide initial={ideWs} /></Suspense>}
        {tab === "chief" && <Chief />}
        {tab === "agents" && <Agents />}
        {tab === "projects" && <Projects />}
        {tab === "costs" && <Costs />}
        {tab === "setup" && <Setup />}
        {tab === "settings" && <SettingsPage />}
      </main>
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => <div key={t.id} className="pointer-events-auto max-w-sm rounded-lg border bg-card px-3 py-2 text-sm shadow-lg">{t.m}</div>)}
      </div>
    </div>
  );
}
