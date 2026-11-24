import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, getConn, inTauri, tauri } from "./api";
import type { LogEvent, State } from "./types";

interface Ctx {
  state: State | null;
  logs: LogEvent[];
  /** Bumped on every WS `activity` event so the Activity tab can refetch with its filters. */
  activityTick: number;
  connected: boolean;
  error: string | null;
  refresh: () => void;
  toast: (m: string) => void;
  toasts: { id: number; m: string }[];
}
const C = createContext<Ctx>(null as never);
export const useStore = () => useContext(C);

async function desktopNotify(title: string, body: string) {
  try {
    if (inTauri()) {
      const n = await import("@tauri-apps/plugin-notification");
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (ok) n.sendNotification({ title, body });
    } else if ("Notification" in window) {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission === "granted") new Notification(title, { body });
    }
  } catch { /* notifications are best effort */ }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [activityTick, setActivityTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; m: string }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const toast = useCallback((m: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, m }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api<State>("/api/state").then((s) => { setState(s); setError(null); }).catch((e) => setError(String(e.message ?? e))), 120);
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    const connect = async () => {
      try {
        const c = await getConn();
        // restore GitHub token from the OS keychain into the orchestrator
        if (inTauri()) {
          const t = await tauri<string | null>("keychain_get").catch(() => null);
          if (t) await api("/api/auth/token", "POST", { token: t }).catch(() => {});
        }
        const [s, l] = await Promise.all([api<State>("/api/state"), api<LogEvent[]>("/api/logs")]);
        setState(s); setLogs(l); setError(null);
        ws = new WebSocket(c.ws);
        ws.onopen = () => setConnected(true);
        ws.onclose = () => { setConnected(false); if (!closed) setTimeout(connect, 2000); };
        ws.onmessage = (m) => {
          const e = JSON.parse(m.data);
          if (e.type === "log") setLogs((p) => [...p.slice(-499), e]);
          else if (e.type === "activity") setActivityTick((n) => n + 1);
          else if (e.type === "notify") { desktopNotify(e.title, e.body); toast(`${e.title}: ${e.body}`); refresh(); }
          else refresh();
        };
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (!closed) setTimeout(connect, 2000);
      }
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [refresh, toast]);

  return <C.Provider value={{ state, logs, activityTick, connected, error, refresh, toast, toasts }}>{children}</C.Provider>;
}
