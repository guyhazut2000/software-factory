export type Effort = "low" | "medium" | "high";

export interface AgentRunSpec {
  prompt: string;
  systemPrompt: string;
  model: string;
  effort: Effort;
  cwd: string;
  maxRuntimeSec: number;
  maxTokens?: number;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; usd?: number }
  | { type: "request_restart"; reason: string }
  | { type: "ask_guy"; question: string }
  | { type: "done"; ok: boolean; summary: string };

export interface ProviderAdapter {
  readonly id: "claude-code" | "codex" | "cursor";
  /** Build the argv that runs the CLI non-interactively with JSON output. */
  buildCommand(spec: AgentRunSpec): string[];
  /** Parse one line of CLI stdout into zero or more normalized events. */
  parseLine(line: string): AgentEvent[];
}
