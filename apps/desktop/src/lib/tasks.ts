import type { Task } from "./types";

/** Card badge: where the task lives (GitHub Issue vs local markdown) and what kind it is. */
export function sourceBadge(t: Pick<Task, "source" | "type" | "issue_number">): { label: string; tone: "primary" | "muted" | "warn" } {
  if (t.source === "github") return { label: t.issue_number ? `GitHub #${t.issue_number}` : "GitHub", tone: "primary" };
  if (t.type === "manual") return { label: "manual", tone: "warn" };
  return { label: `local ${t.type}`, tone: "muted" };
}
