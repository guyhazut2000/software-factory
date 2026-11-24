import { api } from "./api";
import type { LogEvent, Message } from "./types";

/** Agent workspace drawer tabs (docs/PHASE2.md 2.7b). */
export const DRAWER_TABS = ["overview", "settings", "terminal", "files", "diff", "messages", "log"] as const;
export type DrawerTab = (typeof DRAWER_TABS)[number];
export interface DrawerTarget { id: string; tab: DrawerTab }

const EVT = "sf-open-agent";
const bus = new EventTarget();
/** Open the agent drawer from anywhere (cards, Activity board, kanban). */
export function openAgent(id: string, tab: DrawerTab = "overview") {
  bus.dispatchEvent(new CustomEvent<DrawerTarget>(EVT, { detail: { id, tab } }));
}
export function onOpenAgent(fn: (t: DrawerTarget) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<DrawerTarget>).detail);
  bus.addEventListener(EVT, h);
  return () => bus.removeEventListener(EVT, h);
}

export const DRAWER_MIN = 360;
/** Keep the drawer between DRAWER_MIN and 90% of the window. */
export const clampWidth = (w: number, viewport: number) => Math.round(Math.max(DRAWER_MIN, Math.min(w, Math.max(DRAWER_MIN, viewport * 0.9))));

/** Messages the agent sent or received (its direct thread plus bus traffic), oldest first. */
export const agentMessages = (msgs: Message[], agentId: string) =>
  msgs.filter((m) => m.from_id === agentId || m.to_id === agentId).sort((a, b) => a.created_at - b.created_at);

/** Bus messages plus Guy's direct threads with the agent, deduplicated. */
export async function loadAgentMessages(agentId: string): Promise<Message[]> {
  const [bus, threads] = await Promise.all([api<Message[]>("/api/bus"), api<{ id: string; kind: string; agent_id: string | null }[]>("/api/threads")]);
  const direct = await Promise.all(threads.filter((t) => t.kind === "direct" && t.agent_id === agentId).map((t) => api<Message[]>(`/api/threads/${t.id}/messages`)));
  const seen = new Map<string, Message>();
  for (const m of [...bus, ...direct.flat()]) seen.set(m.id, m);
  return [...seen.values()];
}

/** The agent's live events, newest `limit` kept. */
export const agentLogs = (logs: LogEvent[], agentId: string, limit = 300) => logs.filter((l) => l.agent_id === agentId).slice(-limit);

/** IDE workspace id of a task (the task's worktree / branch view). */
export const taskWorkspace = (taskId: string | null | undefined) => (taskId ? `t-${taskId}` : null);

/** Settings-tab hint for "Recreate sandbox": CPU/RAM only apply when a sandbox is created. */
export const recreateHint = (a: { current_task_id: string | null; state: string; cpu: number; ram_mb: number }) =>
  !a.current_task_id
    ? "No task, so no sandbox yet. CPU/RAM apply when the next sandbox is created."
    : a.state === "running"
      ? `Restarts the current run in a fresh sandbox (${a.cpu} CPU / ${a.ram_mb} MB).`
      : `Removes the task's sandbox; the next run recreates it with ${a.cpu} CPU / ${a.ram_mb} MB.`;
