import type { Agent, Question, Thread } from "./types";

/** Parse an ask's JSON `options` column into button labels (bad JSON means no buttons). */
export function askOptions(q: Pick<Question, "options">): string[] {
  if (!q.options) return [];
  try {
    const v: unknown = JSON.parse(q.options);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch { return []; }
}

export interface AskGroup { agent_id: string; name: string; asks: Question[] }

/** Open asks grouped by agent (HQ-style action items): agents with the oldest ask first, asks oldest first. */
export function groupAsks(asks: Question[], agents: Pick<Agent, "id" | "name">[]): AskGroup[] {
  const by = new Map<string, Question[]>();
  for (const q of asks) if ((q.status ?? "open") === "open") by.set(q.agent_id, [...(by.get(q.agent_id) ?? []), q]);
  const groups = [...by].map(([agent_id, list]) => ({ agent_id, name: agents.find((a) => a.id === agent_id)?.name ?? agent_id, asks: list.sort((a, b) => a.asked_at - b.asked_at) }));
  return groups.sort((a, b) => a.asks[0].asked_at - b.asks[0].asked_at);
}

export const KIND_LABEL: Record<string, string> = { question: "Question", approval: "Approval", action: "Action for you", credential: "Credential" };

/** Thread title for the list: chief threads per project, direct/ask threads per agent. */
export function threadLabel(t: Thread, agentName: (id: string | null) => string, projectName: (id: string | null) => string): string {
  if (t.kind === "chief") return `Chief · ${projectName(t.project_id)}`;
  if (t.kind === "direct") return `Direct · ${agentName(t.agent_id)}`;
  return t.title || `Ask · ${agentName(t.agent_id)}`;
}
