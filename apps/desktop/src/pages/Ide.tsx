import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Columns2, Eye, EyeOff, File, FileDiff, Folder, GitBranch, History, Link2Off, Lock, Unlock, Minus, Plus, RefreshCw, Rows2, Save, SquareTerminal, Upload, X } from "lucide-react";
import { TerminalPanel } from "../ide/Terminal";
import { api, ApiError } from "../lib/api";
import { useStore } from "../lib/store";
import { cn } from "../lib/utils";
import { Badge, Button, Input, Select, Textarea } from "../components/ui";
import { CodeView, DiffView, dropModels, isDirty, modelText, resetModel } from "../ide/Editors";
import type { Change, Commit, DiffFile, DiffMode, DiffPair, Entry, FileView, GitStatus, IdeWorkspace } from "../ide/types";

type Tab = { key: string; title: string; kind: "file"; path: string } | { key: string; title: string; kind: "diff"; path: string; orig?: string; mode: DiffMode };
const enc = encodeURIComponent;
const base = (p: string) => p.split("/").pop() ?? p;
/** Only "my workspace" (m-<pid>) is editable; every other workspace stays read-only. */
const editable = (ws: IdeWorkspace) => !ws.read_only && !ws.ref && (ws.kind === "mine" ? ws.exists !== false : ws.kind === "task" && ws.lease?.owner === "guy");
interface Branches { current: string | null; local: { name: string; upstream: string | null; current: boolean }[]; protected: string[] }
/** sha256 each open file was loaded at, kept while it has unsaved edits (the save precondition). */
const baseSha = new Map<string, string | null>();
const STATUS_TONE: Record<string, string> = { M: "text-warn", A: "text-ok", "?": "text-ok", D: "text-danger", R: "text-primary", C: "text-primary", U: "text-danger", T: "text-warn" };

export default function Ide({ initial }: { initial?: string }) {
  const { toast, state } = useStore();
  const [list, setList] = useState<IdeWorkspace[]>([]);
  const [wid, setWid] = useState<string>(initial ?? localStorage.getItem("sf-ide-ws") ?? "");
  const [ws, setWs] = useState<IdeWorkspace | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [rev, setRev] = useState(0); // bump to reload tree/status/content
  const [scRev, setScRev] = useState(0); // bump to reload only source control (after a save)

  const loadList = useCallback(() => api<IdeWorkspace[]>("/api/ws").then((l) => {
    setList(l);
    setWid((cur) => (l.some((w) => w.id === cur) ? cur : l[0]?.id ?? ""));
  }).catch((e) => toast(String(e.message))), [toast]);
  useEffect(() => { loadList(); }, [loadList, state?.projects.length]);
  useEffect(() => { if (initial) setWid(initial); }, [initial]);
  useEffect(() => {
    setTabs([]); setActive(null); setWs(null);
    if (!wid) return;
    const cleanup = () => { dropModels(); baseSha.clear(); };
    localStorage.setItem("sf-ide-ws", wid);
    api<IdeWorkspace>(`/api/ws/${wid}`).then(setWs).catch((e) => toast(String(e.message)));
    return cleanup;
  }, [wid, toast]);

  const open = (t: Tab) => {
    setTabs((ts) => (ts.some((x) => x.key === t.key) ? ts : [...ts, t]));
    setActive(t.key);
  };
  const close = (key: string) => {
    const t = tabs.find((x) => x.key === key);
    if (t?.kind === "file") {
      const u = `${wid}/${t.path}`;
      if (isDirty(u) && !confirm(`Discard unsaved changes to ${t.path}?`)) return;
      dropModels(u); baseSha.delete(u);
    }
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.key === key);
      const next = ts.filter((t) => t.key !== key);
      if (active === key) setActive(next[Math.max(0, i - 1)]?.key ?? null);
      return next;
    });
  };
  const [showTerm, setShowTerm] = useState(() => localStorage.getItem("sf-ide-term") === "1");
  const toggleTerm = () => setShowTerm((v) => { localStorage.setItem("sf-ide-term", v ? "0" : "1"); return !v; });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.ctrlKey && e.key === "`") { e.preventDefault(); toggleTerm(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const [leaseBusy, setLeaseBusy] = useState<"" | "takeover" | "handback">("");
  const lease = (what: "takeover" | "handback") => {
    if (!ws) return;
    setLeaseBusy(what);
    api<IdeWorkspace>(`/api/ws/${ws.id}/${what}`, "POST", {})
      .then((w) => { setWs({ ...w, show_secrets: ws.show_secrets }); loadList(); setRev((r) => r + 1); toast(what === "takeover" ? "Taken over: the agent stopped at a checkpoint" : "Handed back: your edits were pushed and the task is queued"); })
      .catch((e) => toast(String(e.message)))
      .finally(() => setLeaseBusy(""));
  };
  const toggleSecrets = () => ws && api(`/api/ws/${ws.id}/show-secrets`, "POST", { on: !ws.show_secrets }).then(() => { setWs({ ...ws, show_secrets: !ws.show_secrets }); setRev((r) => r + 1); });

  if (!list.length) return <div className="p-8 text-center text-muted-foreground">No workspaces yet. Link a GitHub repository (it is cloned locally) or add a folder project on the Projects tab.</div>;
  const tab = tabs.find((t) => t.key === active);

  return (
    <div className="-m-4 flex h-[calc(100%+2rem)] flex-col">
      <div className="flex items-center gap-2 border-b bg-card px-3 py-1.5">
        <Select className="h-8 w-80" value={wid} onChange={(e) => setWid(e.target.value)}>
          {list.map((w) => <option key={w.id} value={w.id}>{w.kind === "task" ? "Task: " : ""}{w.label}</option>)}
        </Select>
        {ws?.lease?.owner === "agent" ? <Badge tone="warn" title={ws.note}><Lock size={11} />{ws.lease.agent} is working</Badge> : ws?.read_only && <Badge title={ws.note}><Lock size={11} />read-only</Badge>}
        {ws?.lease?.owner === "guy" && <Badge tone="ok" title={ws.note}><Unlock size={11} />taken over</Badge>}
        {ws?.kind === "task" && ws.lease?.owner !== "guy" && <Button size="sm" variant="outline" disabled={!!leaseBusy} title="Soft-stop the agent (checkpoint commit) and edit this workspace yourself" onClick={() => lease("takeover")}>{leaseBusy === "takeover" ? "Taking over..." : "Take over"}</Button>}
        {ws?.lease?.owner === "guy" && <Button size="sm" disabled={!!leaseBusy} title="Commit and push your edits, then give the task back to the agent" onClick={() => lease("handback")}>{leaseBusy === "handback" ? "Handing back..." : "Hand back"}</Button>}
        {ws?.ref && <Badge tone="primary"><GitBranch size={11} />{ws.ref}</Badge>}
        {ws?.kind === "mine" && !ws.exists && <Button size="sm" onClick={() => api<IdeWorkspace>(`/api/ws/${ws.id}/create`, "POST", {}).then((w) => { setWs(w); loadList(); setRev((r) => r + 1); }).catch((e) => toast(String(e.message)))}>Create my workspace</Button>}
        {ws?.note && <span className="truncate text-xs text-muted-foreground">{ws.note}</span>}
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant={showTerm ? "outline" : "ghost"} onClick={toggleTerm} title="Toggle the terminal panel (Ctrl+`)"><SquareTerminal size={13} />terminal</Button>
          <Button size="sm" variant="ghost" onClick={toggleSecrets} title="Show .env, keys and certificates in this project">{ws?.show_secrets ? <Eye size={13} /> : <EyeOff size={13} />}secrets</Button>
          <Button size="icon" variant="ghost" title="Reload" onClick={() => { loadList(); setRev((r) => r + 1); }}><RefreshCw size={14} /></Button>
        </div>
      </div>
      {ws && (
        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_300px]">
          <div className="min-h-0 overflow-auto border-r py-1 text-[13px]"><Tree ws={ws} dir="" depth={0} rev={rev} onOpen={(p) => open({ key: `f:${p}`, title: base(p), kind: "file", path: p })} /></div>
          <div className="flex min-h-0 flex-col">
            <div className="flex min-h-[34px] overflow-x-auto border-b bg-muted/30">
              {tabs.map((t) => (
                <div key={t.key} onClick={() => setActive(t.key)} title={t.path} className={cn("group flex cursor-pointer items-center gap-1.5 border-r px-3 py-1.5 text-xs whitespace-nowrap", t.key === active ? "bg-card font-medium" : "text-muted-foreground hover:bg-muted")}>
                  {t.kind === "diff" ? <FileDiff size={12} /> : <File size={12} />}{t.title}{t.kind === "diff" && <span className="opacity-60">({t.mode})</span>}
                  <button className="cursor-pointer opacity-50 hover:opacity-100" onClick={(e) => { e.stopPropagation(); close(t.key); }}><X size={12} /></button>
                </div>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {!tab && <div className="p-8 text-center text-sm text-muted-foreground">Open a file from the tree, or a change from Source control.</div>}
              {tab?.kind === "file" && <FilePane ws={ws} path={tab.path} rev={rev} onReveal={toggleSecrets} onSaved={() => setScRev((r) => r + 1)} />}
              {tab?.kind === "diff" && <DiffPane ws={ws} tab={tab} rev={rev} />}
            </div>
            {showTerm && <div className="h-[38%] min-h-[140px]"><TerminalPanel key={ws.id} ws={ws} onClose={toggleTerm} /></div>}
          </div>
          <div className="min-h-0 overflow-auto border-l"><SourceControl ws={ws} rev={rev + scRev} onChanged={() => setRev((r) => r + 1)} onDiff={(c, mode) => open({ key: `d:${mode}:${c.path}`, title: base(c.path), kind: "diff", path: c.path, orig: c.orig_path, mode })} /></div>
        </div>
      )}
    </div>
  );
}

function Tree({ ws, dir, depth, rev, onOpen }: { ws: IdeWorkspace; dir: string; depth: number; rev: number; onOpen: (p: string) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState("");
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  useEffect(() => {
    api<Entry[]>(`/api/ws/${ws.id}/tree?path=${enc(dir)}`).then(setEntries).catch((e) => setErr(String(e.message)));
  }, [ws.id, dir, rev]);
  const pad = { paddingLeft: 8 + depth * 12 };
  if (err) return <div style={pad} className="py-0.5 text-xs text-danger">{err}</div>;
  if (!entries) return <div style={pad} className="py-0.5 text-xs text-muted-foreground">loading...</div>;
  if (!entries.length && !depth) return <div className="p-3 text-xs text-muted-foreground">Empty (the clone may still be downloading; press reload).</div>;
  return (
    <>
      {entries.map((e) => {
        const isOpen = openDirs.has(e.path);
        if (e.type === "dir")
          return (
            <div key={e.path}>
              <div style={pad} className="flex cursor-pointer items-center gap-1 py-0.5 hover:bg-muted" onClick={() => setOpenDirs((s) => { const n = new Set(s); if (isOpen) n.delete(e.path); else n.add(e.path); return n; })}>
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={13} className="text-primary" />{e.name}
              </div>
              {isOpen && <Tree ws={ws} dir={e.path} depth={depth + 1} rev={rev} onOpen={onOpen} />}
            </div>
          );
        const disabled = e.type === "symlink" || e.type === "submodule";
        return (
          <div key={e.path} style={{ paddingLeft: 8 + depth * 12 + 17 }} title={e.outside ? "symlink to outside the workspace (not followed)" : e.type === "submodule" ? "git submodule" : e.path}
            className={cn("flex items-center gap-1 py-0.5", disabled ? "text-muted-foreground" : "cursor-pointer hover:bg-muted")} onClick={() => !disabled && onOpen(e.path)}>
            {e.outside ? <Link2Off size={13} /> : <File size={13} className="opacity-60" />}<span className="truncate">{e.name}</span>{e.secret && <Lock size={10} className="opacity-60" />}
          </div>
        );
      })}
    </>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function FilePane({ ws, path, rev, onReveal, onSaved }: { ws: IdeWorkspace; path: string; rev: number; onReveal: () => void; onSaved: () => void }) {
  const { toast } = useStore();
  const [f, setF] = useState<FileView | null>(null);
  const [err, setErr] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ mine: string; theirs: FileView | null } | null>(null);
  const uri = `${ws.id}/${path}`;
  const canEdit = editable(ws);
  useEffect(() => {
    setErr(""); setConflict(null);
    api<FileView>(`/api/ws/${ws.id}/file?path=${enc(path)}`).then((x) => {
      if (!isDirty(uri) || !baseSha.has(uri)) baseSha.set(uri, x.sha256 ?? null);
      setF(x);
    }).catch((e) => setErr(String(e.message)));
  }, [ws.id, path, rev, uri]);
  const put = async (content: string, base_sha: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api<{ sha256: string; size: number }>(`/api/ws/${ws.id}/file?path=${enc(path)}`, "PUT", { content, base_sha });
      resetModel(uri, content);
      baseSha.set(uri, r.sha256);
      setF((x) => (x ? { ...x, content, sha256: r.sha256, size: r.size } : x));
      setDirty(false); setConflict(null); onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const theirs = await api<FileView>(`/api/ws/${ws.id}/file?path=${enc(path)}`).catch(() => null);
        setConflict({ mine: content, theirs });
      } else toast(`Save failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };
  const reload = () => {
    const t = conflict?.theirs;
    if (t) { resetModel(uri, t.content ?? ""); baseSha.set(uri, t.sha256 ?? null); setF(t); } else setErr(`${path} no longer exists.`);
    setDirty(false); setConflict(null);
  };
  if (err) return <Notice>{err}</Notice>;
  if (!f || f.path !== path) return <Notice>loading...</Notice>;
  if (f.too_large) return <Notice>{path} is {(f.size / 1048576).toFixed(1)} MB, over the 2 MB editor limit.</Notice>;
  if (f.binary) return <Notice>{path} is a binary file ({f.size} bytes).</Notice>;
  if (f.masked) return <Notice>{path} may contain secrets, so it is hidden. <Button size="sm" variant="outline" onClick={onReveal}><Eye size={12} />Show secrets for this project</Button></Notice>;
  if (conflict) return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b bg-warn/10 px-3 py-1 text-xs">
        <span className="truncate">{conflict.theirs ? "This file changed on disk since you opened it. Left: on disk, right: yours." : "This file was deleted on disk."}</span>
        <Button className="ml-auto" size="sm" disabled={busy} onClick={() => put(conflict.mine, conflict.theirs?.sha256 ?? null)}>Keep mine</Button>
        <Button size="sm" variant="outline" onClick={reload}>Reload from disk</Button>
      </div>
      <div className="min-h-0 flex-1"><DiffView original={conflict.theirs?.content ?? ""} modified={conflict.mine} language={f.language} /></div>
    </div>
  );
  const view = <CodeView uri={uri} value={f.content ?? ""} language={f.language} onSave={canEdit ? (c) => put(c, baseSha.get(uri) ?? null) : undefined} onDirty={setDirty} />;
  if (!canEdit) return view;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
        <span className="truncate">{path}</span>{dirty && <span className="text-warn" title="Unsaved changes">● unsaved</span>}
        <Button className="ml-auto" size="sm" variant="ghost" disabled={!dirty || busy} title="Save (Ctrl+S)" onClick={() => { const c = modelText(uri); if (c != null) put(c, baseSha.get(uri) ?? null); }}><Save size={12} />Ctrl+S</Button>
      </div>
      <div className="min-h-0 flex-1">{view}</div>
    </div>
  );
}

function blobText(b: DiffPair["original"]): string | null {
  if (!b.exists) return "";
  if (b.too_large) return null;
  if (b.binary || b.masked) return null;
  return b.content ?? "";
}

function DiffPane({ ws, tab, rev }: { ws: IdeWorkspace; tab: Extract<Tab, { kind: "diff" }>; rev: number }) {
  const [d, setD] = useState<DiffPair | null>(null);
  const [err, setErr] = useState("");
  const [inline, setInline] = useState(false);
  useEffect(() => {
    setErr(""); setD(null);
    api<DiffPair>(`/api/ws/${ws.id}/git/diff?mode=${tab.mode}&path=${enc(tab.path)}${tab.orig ? `&orig=${enc(tab.orig)}` : ""}`).then(setD).catch((e) => setErr(String(e.message)));
  }, [ws.id, tab.mode, tab.path, tab.orig, rev]);
  if (err) return <Notice>{err}</Notice>;
  if (!d) return <Notice>loading...</Notice>;
  const a = blobText(d.original), b = blobText(d.modified);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
        <span className="truncate">{d.orig_path ? `${d.orig_path} -> ` : ""}{d.path}</span><span>{d.label}</span>
        <Button className="ml-auto" size="sm" variant="ghost" onClick={() => setInline(!inline)}>{inline ? <Columns2 size={12} /> : <Rows2 size={12} />}{inline ? "side by side" : "inline"}</Button>
      </div>
      <div className="min-h-0 flex-1">
        {a === null || b === null ? <Notice>This change cannot be shown as text (binary, secret or over 2 MB).</Notice> : <DiffView original={a} modified={b} language={d.language} inline={inline} />}
      </div>
    </div>
  );
}

function ChangeRow({ path, code, onClick, action }: { path: string; code: string; onClick: () => void; action?: { label: string; icon: React.ReactNode; run: () => void } }) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (
    <div className="flex cursor-pointer items-center gap-1.5 px-3 py-0.5 text-[13px] hover:bg-muted" title={path} onClick={onClick}>
      <span className="truncate">{base(path)}</span><span className="truncate text-[11px] text-muted-foreground">{dir}</span>
      <span className={cn("ml-auto font-mono text-[11px] font-semibold", STATUS_TONE[code] ?? "")}>{code === "?" ? "U" : code}</span>
      {action && <button className="cursor-pointer rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100" title={action.label} aria-label={action.label} onClick={(e) => { e.stopPropagation(); action.run(); }}>{action.icon}</button>}
    </div>
  );
}

function SourceControl({ ws, rev, onDiff, onChanged }: { ws: IdeWorkspace; rev: number; onChanged: () => void; onDiff: (c: { path: string; orig_path?: string }, mode: DiffMode) => void }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [taskFiles, setTaskFiles] = useState<{ label: string; files: DiffFile[]; truncated: boolean } | null>(null);
  const [log, setLog] = useState<Commit[]>([]);
  const [err, setErr] = useState("");
  const { toast } = useStore();
  const canWrite = editable(ws);
  const [br, setBr] = useState<Branches | null>(null);
  const [msg, setMsg] = useState("");
  const [newBr, setNewBr] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    setBr(null);
    if (canWrite && ws.git) api<Branches>(`/api/ws/${ws.id}/git/branches`).then(setBr).catch(() => {});
  }, [ws.id, ws.git, canWrite, rev]);
  /** Run one git write, then reload tree, files and status. */
  const run = async (what: string, path: string, body: unknown, done?: (r: Record<string, unknown>) => void) => {
    setBusy(what);
    try { const r = await api<Record<string, unknown>>(`/api/ws/${ws.id}/git/${path}`, "POST", body); done?.(r); onChanged(); }
    catch (e) { toast(`${what} failed: ${(e as Error).message}`); }
    finally { setBusy(""); }
  };
  useEffect(() => {
    setErr(""); setSt(null); setTaskFiles(null); setLog([]);
    if (!ws.git) return;
    if (ws.kind === "task") api<typeof taskFiles>(`/api/ws/${ws.id}/git/diff?mode=task`).then(setTaskFiles).catch((e) => setErr(String(e.message)));
    if (!ws.ref) api<GitStatus>(`/api/ws/${ws.id}/git/status`).then(setSt).catch((e) => setErr(String(e.message)));
    api<Commit[]>(`/api/ws/${ws.id}/git/log?limit=15`).then(setLog).catch(() => {});
  }, [ws.id, ws.git, ws.kind, ws.ref, rev]);
  const staged = useMemo(() => st?.changes.filter((c) => c.staged !== ".") ?? [], [st]);
  const unstaged = useMemo(() => st?.changes.filter((c) => c.unstaged !== ".") ?? [], [st]);
  if (!ws.git) return <div className="p-3 text-xs text-muted-foreground">This folder is not a git repository.</div>;
  const H = ({ children }: { children: React.ReactNode }) => <div className="mt-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>;
  return (
    <div className="pb-4">
      {err && <div className="p-3 text-xs text-danger">{err}</div>}
      {st && !canWrite && <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs"><GitBranch size={13} />{st.branch ?? "detached HEAD"}{(st.ahead > 0 || st.behind > 0) && <span className="text-muted-foreground">+{st.ahead} / -{st.behind}</span>}</div>}
      {st && canWrite && (
        <div className="space-y-2 border-b px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <GitBranch size={13} className="shrink-0" />
            <Select className="h-7 min-w-0 flex-1 text-xs" aria-label="Branch" value={br?.current ?? st.branch ?? ""} disabled={!!busy || !br}
              onChange={(e) => run("Checkout", "checkout", { name: e.target.value })}>
              {!br?.current && <option value="">{st.branch ?? "detached HEAD"}</option>}
              {br?.local.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </Select>
            {(st.ahead > 0 || st.behind > 0) && <span className="text-muted-foreground">+{st.ahead}/-{st.behind}</span>}
          </div>
          <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (newBr.trim()) run("Create branch", "branch", { name: newBr.trim(), checkout: true }, () => setNewBr("")); }}>
            <Input className="h-7 text-xs" placeholder="new-branch-name" aria-label="New branch name" value={newBr} onChange={(e) => setNewBr(e.target.value)} />
            <Button size="sm" variant="outline" type="submit" disabled={!!busy || !newBr.trim()} title="Create the branch and check it out"><Plus size={12} />Branch</Button>
          </form>
          <Textarea className="min-h-[56px] text-xs" placeholder="Commit message" aria-label="Commit message" value={msg} onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && msg.trim() && staged.length) run("Commit", "commit", { message: msg }, () => setMsg("")); }} />
          <div className="flex gap-1">
            <Button size="sm" className="flex-1" disabled={!!busy || !msg.trim() || !staged.length} title="Commit staged changes (Ctrl+Enter)" onClick={() => run("Commit", "commit", { message: msg }, () => setMsg(""))}>{busy === "Commit" ? "Committing..." : `Commit (${staged.length})`}</Button>
            {(() => {
              const b = br?.current ?? st.branch;
              const blocked = !b || !!br?.protected.includes(b);
              return <Button size="sm" variant="outline" disabled={!!busy || blocked} title={blocked ? "Pushing to main is not allowed: create a feature branch" : `Push ${b} to origin`}
                onClick={() => run("Push", "push", {}, (r) => toast(`Pushed ${String(r.pushed ?? b)}`))}><Upload size={12} />{busy === "Push" ? "Pushing..." : "Push"}</Button>;
            })()}
          </div>
        </div>
      )}
      {taskFiles && (
        <>
          <H>Task changes ({taskFiles.files.length})</H>
          <div className="px-3 pb-1 text-[11px] text-muted-foreground">{taskFiles.label}</div>
          {taskFiles.files.map((f) => <ChangeRow key={f.path} path={f.path} code={f.status} onClick={() => onDiff(f, "task")} />)}
          {!taskFiles.files.length && <div className="px-3 text-xs text-muted-foreground">No changes yet.</div>}
        </>
      )}
      {st && (
        <>
          <H><span className="flex items-center">Staged ({staged.length}){canWrite && staged.length > 0 && <button className="ml-auto cursor-pointer normal-case hover:text-foreground" disabled={!!busy} onClick={() => run("Unstage", "unstage", { all: true })}>unstage all</button>}</span></H>
          {staged.map((c: Change) => <ChangeRow key={c.path} path={c.path} code={c.staged} onClick={() => onDiff(c, "staged")} action={canWrite ? { label: `Unstage ${c.path}`, icon: <Minus size={12} />, run: () => run("Unstage", "unstage", { paths: [c.path] }) } : undefined} />)}
          <H><span className="flex items-center">Changes ({unstaged.length}){canWrite && unstaged.length > 0 && <button className="ml-auto cursor-pointer normal-case hover:text-foreground" disabled={!!busy} onClick={() => run("Stage", "stage", { all: true })}>stage all</button>}</span></H>
          {unstaged.map((c: Change) => <ChangeRow key={c.path} path={c.path} code={c.unstaged} onClick={() => onDiff(c, "unstaged")} action={canWrite ? { label: `Stage ${c.path}`, icon: <Plus size={12} />, run: () => run("Stage", "stage", { paths: [c.path] }) } : undefined} />)}
          {!st.changes.length && <div className="px-3 text-xs text-muted-foreground">Working tree clean.</div>}
          {st.truncated && <div className="px-3 text-xs text-warn">List truncated.</div>}
        </>
      )}
      <H><span className="inline-flex items-center gap-1"><History size={11} />History</span></H>
      {log.map((c) => (
        <div key={c.sha} className="px-3 py-1 text-xs" title={c.sha}>
          <div className="truncate">{c.subject}</div>
          <div className="text-[11px] text-muted-foreground">{c.sha.slice(0, 7)} / {c.author} / {new Date(c.at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}
