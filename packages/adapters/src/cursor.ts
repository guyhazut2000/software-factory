import type { AgentEvent, AgentRunSpec, BuiltCommand, ProviderAdapter } from "./types.js";

type Ev = {
  type?: string;
  subtype?: string;
  message?: { content?: { type: string; text?: string }[] };
  tool_call?: Record<string, unknown>;
  result?: string;
  is_error?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
};

/**
 * Flags verified in https://cursor.com/docs/cli/reference/parameters (-p, --output-format stream-json,
 * --force, --trust, --approve-mcps, --model, --workspace, --mode ask). The binary is `cursor-agent` or `agent`.
 * Event schema parsed tolerantly: UNVERIFIED on a live run. MCP is configured via .cursor/mcp.json (written as an extra file).
 */
export const cursorAdapter: ProviderAdapter = {
  id: "cursor",
  executables: ["cursor-agent", "agent"],
  sbxAgent: "cursor",
  buildCommand(spec: AgentRunSpec): BuiltCommand {
    const argv = ["cursor-agent", "-p", "--output-format", "stream-json", "--trust", "--approve-mcps", "--model", spec.model, "--workspace", spec.cwd];
    if (spec.readOnly) argv.push("--mode", "ask");
    else argv.push("--force");
    const prompt = spec.systemPrompt ? `${spec.systemPrompt}\n\n---\n\n${spec.prompt}` : spec.prompt;
    argv.push(prompt);
    const files: Record<string, string> = {};
    if (spec.factoryMcpUrl) files[".cursor/mcp.json"] = JSON.stringify({ mcpServers: { factory: { url: spec.factoryMcpUrl } } });
    return { argv, files };
  },
  parseLine(line: string): AgentEvent[] {
    let ev: Ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return [];
    }
    if (ev.type === "assistant") {
      return (ev.message?.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => ({ type: "text" as const, text: c.text! }));
    }
    if (ev.type === "tool_call" && ev.subtype === "started") {
      return [{ type: "tool_call", name: Object.keys(ev.tool_call ?? {})[0] ?? "tool", input: ev.tool_call }];
    }
    if (ev.type === "result") {
      const out: AgentEvent[] = [];
      if (ev.usage) out.push({ type: "usage", inputTokens: ev.usage.inputTokens ?? 0, outputTokens: ev.usage.outputTokens ?? 0 });
      out.push({ type: "done", ok: !ev.is_error, summary: ev.result ?? "" });
      return out;
    }
    return [];
  },
};
