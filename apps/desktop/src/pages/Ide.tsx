import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Columns2, Eye, EyeOff, File, FileDiff, Folder, GitBranch, History, Link2Off, Lock, RefreshCw, Rows2, X } from "lucide-react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { cn } from "../lib/utils";
import { Badge, Button, Select } from "../components/ui";
import { CodeView, DiffView } from "../ide/Editors";
import type { Change, Commit, DiffFile, DiffMode, DiffPair, Entry, FileView, GitStatus, IdeWorkspace } from "../ide/types";

type Tab = { key: string; title: string; kind: "file"; path: string } | { key: string; title: string; kind: "diff"; path: string; orig?: string; mode: DiffMode };
const enc = encodeURIComponent;
const base = (p: string) => p.split("/").pop() ?? p;
const STATUS_TONE: Record<string, string> = { M: "text-warn", A: "text-ok", "?": "text-ok", D: "text-danger", R: "text-primary", C: "text-primary", U: "text-danger", T: "text-warn" };

export default function Ide({ initial }: { initial?: string }) {
  const { toast, state } = useStore();
  const [list, setList] = useState<IdeWorkspace[]>([]);
  const [wid, setWid] = useState<string>(initial ?? localStorage.getItem("sf-ide-ws") ?? "");
  const [ws, setWs] = useState<IdeWorkspace | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [rev, setRev] = useState(0); // bump to reload tree/status/content

  const loadList = useCallback(() => api<IdeWorkspace[]>("/api/ws").then((l) => {
    setList(l);
    setWid((cur) => (l.some((w) => w.id === cur) ? cur : l[0]?.id ?? ""));
  }).catch((e) => toast(String(e.message))), [toast]);
  useEffect(() => { loadList(); }, [loadList, state?.projects.length]);
  useEffect(() => { if (initial) setWid(initial); }, [initial]);
  useEffect(() => {
    setTabs([]); setActive(null); setWs(null);
    if (!wid) return;
    localStorage.setItem("sf-ide-ws", wid);
    api<IdeWorkspace>(`/api/ws/${wid}`).then(setWs).catch((e) => toast(String(e.message)));
  }, [wid, toast]);

  const open = (t: Tab) => {
    setTabs((ts) => (ts.some((x) => x.key === t.key) ? ts : [...ts, t]));
    setActive(t.key);
  };
  const close = (key: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.key === key);
      const next = ts.filter((t) => t.key !== key);
      if (active === key) setActive(next[Math.max(0, i - 1)]?.key ?? null);
      return next;
    });
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
        {ws?.read_only && <Badge title={ws.note}><Lock size={11} />read-only</Badge>}
        {ws?.ref && <Badge tone="primary"><GitBranch size={11} />{ws.ref}</Badge>}
        {ws?.note && <span className="truncate text-xs text-muted-foreground">{ws.note}</span>}
        <div className="ml-auto flex gap-1">
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
              {tab?.kind === "file" && <FilePane ws={ws} path={tab.path} rev={rev} onReveal={toggleSecrets} />}
              {tab?.kind === "diff" && <DiffPane ws={ws} tab={tab} rev={rev} />}
            </div>
          </div>
          <div className="min-h-0 overflow-auto border-l"><SourceControl ws={ws} rev={rev} onDiff={(c, mode) => open({ key: `d:${mode}:${c.path}`, title: base(c.path), kind: "diff", path: c.path, orig: c.orig_path, mode })} /></div>
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

function FilePane({ ws, path, rev, onReveal }: { ws: IdeWorkspace; path: string; rev: number; onReveal: () => void }) {
  const [f, setF] = useState<FileView | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setErr("");
    api<FileView>(`/api/ws/${ws.id}/file?path=${enc(path)}`).then(setF).catch((e) => setErr(String(e.message)));
  }, [ws.id, path, rev]);
  if (err) return <Notice>{err}</Notice>;
  if (!f || f.path !== path) return <Notice>loading...</Notice>;
  if (f.too_large) return <Notice>{path} is {(f.size / 1048576).toFixed(1)} MB, over the 2 MB editor limit.</Notice>;
  if (f.binary) return <Notice>{path} is a binary file ({f.size} bytes).</Notice>;
  if (f.masked) return <Notice>{path} may contain secrets, so it is hidden. <Button size="sm" variant="outline" onClick={onReveal}><Eye size={12} />Show secrets for this project</Button></Notice>;
  return <CodeView uri={`${ws.id}/${path}`} value={f.content ?? ""} language={f.language} />;
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

function ChangeRow({ path, code, onClick }: { path: string; code: string; onClick: () => void }) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (
    <div className="flex cursor-pointer items-center gap-1.5 px-3 py-0.5 text-[13px] hover:bg-muted" title={path} onClick={onClick}>
      <span className="truncate">{base(path)}</span><span className="truncate text-[11px] text-muted-foreground">{dir}</span>
      <span className={cn("ml-auto font-mono text-[11px] font-semibold", STATUS_TONE[code] ?? "")}>{code === "?" ? "U" : code}</span>
    </div>
  );
}

function SourceControl({ ws, rev, onDiff }: { ws: IdeWorkspace; rev: number; onDiff: (c: { path: string; orig_path?: string }, mode: DiffMode) => void }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [taskFiles, setTaskFiles] = useState<{ label: string; files: DiffFile[]; truncated: boolean } | null>(null);
  const [log, setLog] = useState<Commit[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    setErr(""); setSt(null); setTaskFiles(null); setLog([]);
    if (!ws.git) return;
    if (ws.kind === "task") api<typeof taskFiles>(`/api/ws/${ws.id}/git/diff?mode=task`).then(setTaskFiles).catch((e) => setErr(String(e.message)));
    if (!ws.ref) api<GitStatus>(`/api/ws/${ws.id}/git/status`).then(setSt).catch((e) => setErr(String(e.message)));
    api<Commit[]>(`/api/ws/${ws.id}/git/log?limit=30`).then(setLog).catch(() => {});
  }, [ws.id, ws.git, ws.kind, ws.ref, rev]);
  const staged = useMemo(() => st?.changes.filter((c) => c.staged !== ".") ?? [], [st]);
  const unstaged = useMemo(() => st?.changes.filter((c) => c.unstaged !== ".") ?? [], [st]);
  if (!ws.git) return <div className="p-3 text-xs text-muted-foreground">This folder is not a git repository.</div>;
  const H = ({ children }: { children: React.ReactNode }) => <div className="mt-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>;
  return (
    <div className="pb-4">
      {err && <div className="p-3 text-xs text-danger">{err}</div>}
      {st && <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs"><GitBranch size={13} />{st.branch ?? "detached HEAD"}{(st.ahead > 0 || st.behind > 0) && <span className="text-muted-foreground">+{st.ahead} / -{st.behind}</span>}</div>}
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
          <H>Staged ({staged.length})</H>
          {staged.map((c: Change) => <ChangeRow key={c.path} path={c.path} code={c.staged} onClick={() => onDiff(c, "staged")} />)}
          <H>Changes ({unstaged.length})</H>
          {unstaged.map((c: Change) => <ChangeRow key={c.path} path={c.path} code={c.unstaged} onClick={() => onDiff(c, "unstaged")} />)}
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
