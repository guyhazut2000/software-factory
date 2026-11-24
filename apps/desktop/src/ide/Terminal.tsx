import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, ApiError, getConn } from "../lib/api";
import { cn } from "../lib/utils";
import type { IdeWorkspace } from "./types";

export interface TermInfo { id: string; label: string; workspace_id: string; cwd: string; shell: string; exited: number | null }
interface TermList { available: boolean; error?: string; sessions: TermInfo[] }

const UNAVAILABLE = "The terminal is not available on this machine: the native PTY module (node-pty) could not be loaded. Reinstall with `pnpm install`, or check the orchestrator log.";

/** One xterm.js view attached to a PTY session over WS /term (binary keys, JSON resize, replay on reconnect). */
export function XTerm({ id, visible, onExit }: { id: string; visible: boolean; onExit?: (code: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, Menlo, Consolas, monospace", scrollback: 5000, theme: { background: "#0b0f14" } });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(box.current!);
    const enc = new TextEncoder();
    let ws: WebSocket | null = null, disposed = false, exited = false, tries = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const sendResize = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    const safeFit = () => { try { if (box.current?.offsetWidth) fit.fit(); } catch { /* not laid out yet */ } };
    const connect = async () => {
      const c = await getConn();
      if (disposed) return;
      const s = new WebSocket(`${c.base.replace(/^http/, "ws")}/term?token=${encodeURIComponent(c.token)}&session=${encodeURIComponent(id)}`);
      s.binaryType = "arraybuffer";
      ws = s;
      let first = true;
      s.onopen = () => { tries = 0; safeFit(); sendResize(); };
      s.onmessage = (ev) => {
        if (first) { first = false; term.reset(); } // the server replays its buffer on every (re)connect
        if (typeof ev.data !== "string") return term.write(new Uint8Array(ev.data as ArrayBuffer));
        try {
          const m = JSON.parse(ev.data) as { type?: string; code?: number };
          if (m.type === "exit") { exited = true; term.write(`\r\n\x1b[2m[process exited with code ${m.code ?? "?"}]\x1b[0m\r\n`); exitRef.current?.(m.code ?? 0); }
        } catch { term.write(ev.data); }
      };
      s.onclose = () => {
        if (disposed || exited) return;
        if (++tries > 5) return term.write("\r\n\x1b[31m[disconnected from the terminal session]\x1b[0m\r\n");
        timer = setTimeout(connect, Math.min(500 * 2 ** tries, 5000));
      };
    };
    connect();
    const d1 = term.onData((d) => ws?.readyState === 1 && ws.send(enc.encode(d)));
    const d2 = term.onBinary((d) => ws?.readyState === 1 && ws.send(Uint8Array.from(d, (ch) => ch.charCodeAt(0) & 255)));
    const d3 = term.onResize(sendResize);
    const ro = new ResizeObserver(safeFit);
    ro.observe(box.current!);
    return () => { disposed = true; clearTimeout(timer); ro.disconnect(); d1.dispose(); d2.dispose(); d3.dispose(); ws?.close(); term.dispose(); };
  }, [id]);

  useEffect(() => { if (visible) requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* hidden */ } }); }, [visible]);
  return <div ref={box} className={cn("h-full w-full bg-[#0b0f14] p-1", !visible && "hidden")} />;
}

/** Guy's project terminals for one workspace: tabs, new, close. Sessions outlive a page reload. */
export function TerminalPanel({ ws, onClose }: { ws: IdeWorkspace; onClose: () => void }) {
  const [list, setList] = useState<TermInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const noFolder = ws.ref ? "This workspace is pinned to a git ref and has no folder on disk." : ws.kind === "mine" && !ws.exists ? "Create your workspace first to open a terminal in it." : "";

  const create = useCallback(async () => {
    setBusy(true);
    try {
      const t = await api<TermInfo>("/api/term", "POST", { workspace: ws.id });
      setErr("");
      setList((l) => [...l, t]);
      setActive(t.id);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 503 ? UNAVAILABLE : String((e as Error).message));
    } finally { setBusy(false); }
  }, [ws.id]);

  useEffect(() => {
    let live = true;
    setList([]); setActive(null); setErr("");
    if (noFolder) return;
    api<TermList>("/api/term").then((r) => {
      if (!live) return;
      if (!r.available) return setErr(UNAVAILABLE);
      const mine = r.sessions.filter((s) => s.workspace_id === ws.id);
      if (mine.length) { setList(mine); setActive(mine[mine.length - 1]!.id); } else create();
    }).catch((e) => live && setErr(String(e.message)));
    return () => { live = false; };
  }, [ws.id, noFolder]);

  const kill = (id: string) => {
    api(`/api/term/${id}`, "DELETE").catch(() => {});
    setList((l) => {
      const n = l.filter((t) => t.id !== id);
      if (active === id) setActive(n.length ? n[n.length - 1]!.id : null);
      return n;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-t">
      <div className="flex min-h-[30px] items-center overflow-x-auto border-b bg-muted/30 text-xs">
        <span className="flex items-center gap-1 px-2 font-semibold uppercase tracking-wide text-muted-foreground"><SquareTerminal size={12} />Terminal</span>
        {list.map((t, i) => (
          <div key={t.id} onClick={() => setActive(t.id)} title={`${t.shell} in ${t.cwd}`} className={cn("group flex cursor-pointer items-center gap-1.5 border-r px-3 py-1 whitespace-nowrap", t.id === active ? "bg-card font-medium" : "text-muted-foreground hover:bg-muted")}>
            {i + 1}: {t.label}{t.exited !== null && <span className="opacity-60">(exited)</span>}
            <button title="Close terminal (kills the shell)" className="cursor-pointer opacity-50 hover:opacity-100" onClick={(e) => { e.stopPropagation(); kill(t.id); }}><X size={12} /></button>
          </div>
        ))}
        <button title="New terminal in the workspace root" disabled={busy || !!noFolder} className="cursor-pointer px-2 py-1 opacity-70 hover:opacity-100 disabled:opacity-30" onClick={create}><Plus size={13} /></button>
        <button title="Hide terminal panel (shells keep running)" className="ml-auto cursor-pointer px-2 py-1 opacity-70 hover:opacity-100" onClick={onClose}><X size={13} /></button>
      </div>
      <div className="relative min-h-0 flex-1">
        {(noFolder || err) && <div className="p-4 text-sm text-muted-foreground">{noFolder || err}</div>}
        {!noFolder && !err && !list.length && <div className="p-4 text-sm text-muted-foreground">No terminal open. Click + to start a shell in this workspace.</div>}
        {list.map((t) => <XTerm key={t.id} id={t.id} visible={t.id === active} onExit={(code) => setList((l) => l.map((x) => (x.id === t.id ? { ...x, exited: code } : x)))} />)}
      </div>
    </div>
  );
}
