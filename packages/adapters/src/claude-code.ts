import type { AgentEvent, AgentRunSpec, BuiltCommand, ProviderAdapter } from "./types.js";

type Block = { type: string; text?: string; name?: string; input?: unknown };
type Msg = {
  type?: string;
  message?: { content?: Block[]; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number } };
  total_cost_usd?: number;
  result?: string;
  is_error?: boolean;
};

/** Flags verified against https://docs.claude.com/en/docs/claude-code/cli-reference (Nov 2026). */
export const claudeCodeAdapter: ProviderAdapter = {
  id: "claude-code",
  executables: ["claude"],
  sbxAgent: "claude",
  buildCommand(spec: AgentRunSpec): BuiltCommand {
    const argv = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", spec.model, "--effort", spec.effort];
    if (spec.systemPrompt) argv.push("--append-system-prompt", spec.systemPrompt);
    if (spec.mcpConfigPath) argv.push("--mcp-config", spec.mcpConfigPath);
    if (spec.settingsPath) argv.push("--settings", spec.settingsPath);
    if (spec.maxTurns) argv.push("--max-turns", String(spec.maxTurns));
    if (spec.readOnly) {
      argv.push("--allowedTools", "mcp__factory Read Glob Grep", "--permission-mode", "default");
    } else if (spec.sandboxed) {
      argv.push("--permission-mode", "bypassPermissions");
    } else {
      argv.push("--permission-mode", "acceptEdits", "--allowedTools", "Bash(git:*) Bash(npm:*) Bash(pnpm:*) Bash(node:*) Bash(npx:*) mcp__factory");
    }
    return { argv, stdin: spec.prompt };
  },
  parseLine(line: string): AgentEvent[] {
    let msg: Msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    const out: AgentEvent[] = [];
    if (msg.type === "assistant") {
      for (const c of msg.message?.content ?? []) {
        if (c.type === "text" && c.text) out.push({ type: "text", text: c.text });
        if (c.type === "tool_use") out.push({ type: "tool_call", name: c.name ?? "?", input: c.input });
      }
      const u = msg.message?.usage;
      if (u) out.push({ type: "usage", inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 });
    } else if (msg.type === "result") {
      if (msg.total_cost_usd) out.push({ type: "cost", usd: msg.total_cost_usd });
      out.push({ type: "done", ok: !msg.is_error, summary: msg.result ?? "" });
    }
    return out;
  },
};
