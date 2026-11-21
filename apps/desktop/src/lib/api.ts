interface Conn { base: string; token: string; ws: string }
let conn: Promise<Conn> | null = null;

declare global { interface Window { __TAURI_INTERNALS__?: unknown } }
export const inTauri = () => typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

export async function tauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function getConn(): Promise<Conn> {
  conn ??= (async () => {
    let port = 47821, token = "dev";
    if (inTauri()) {
      const info = await tauri<{ port: number; token: string }>("orchestrator_info");
      port = info.port; token = info.token;
    } else {
      const q = new URLSearchParams(location.search);
      port = Number(q.get("port") ?? import.meta.env.VITE_SF_PORT ?? 47821);
      token = q.get("token") ?? import.meta.env.VITE_SF_TOKEN ?? "dev";
    }
    return { base: `http://127.0.0.1:${port}`, token, ws: `ws://127.0.0.1:${port}/ws?token=${token}` };
  })();
  return conn;
}

export async function api<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const c = await getConn();
  const r = await fetch(c.base + path, { method, headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}
