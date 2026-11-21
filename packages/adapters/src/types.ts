export type Effort = "low" | "medium" | "high";
export type ProviderId = "claude-code" | "codex" | "cursor";

export interface AgentRunSpec {
  /** Task prompt (sent via stdin when the CLI supports it). */
  prompt: string;
  /** Role system prompt + generated project instructions. */
  systemPrompt: string;
  model: string;
  effort: Effort;
  cwd: string;
  /** True when running inside an isolated sandbox: allows full autonomy. */
  sandboxed: boolean;
  /** Read-only agents (Chief): no edits, no shell. */
  readOnly?: boolean;
  /** Path (inside the execution environment) of an MCP config JSON file. */
  mcpConfigPath?: string;
  /** Path of a Claude Code settings JSON (hooks). */
  settingsPath?: string;
  /** URL of the factory MCP server (for CLIs configured inline). */
  factoryMcpUrl?: string;
  maxTurns?: number;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "cost"; usd: number }
  | { type: "done"; ok: boolean; summary: string };

export interface BuiltCommand {
  /** argv, first element is the executable name (resolved via PATH). */
  argv: string[];
  /** Text written to stdin (then closed), if any. */
  stdin?: string;
  /** Extra files to write before running: relative to cwd. */
  files?: Record<string, string>;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Candidate executable names, first found wins. */
  readonly executables: string[];
  /** Name of this agent in `sbx` (sbx create <agent>). */
  readonly sbxAgent: string;
  buildCommand(spec: AgentRunSpec): BuiltCommand;
  parseLine(line: string): AgentEvent[];
}

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "file_change", "edit", "write"]);
