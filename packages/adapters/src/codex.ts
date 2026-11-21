import type { AgentEvent, AgentRunSpec, BuiltCommand, ProviderAdapter } from "./types.js";

type Ev = {
  type?: string;
  item?: { type?: string; text?: string; command?: string; changes?: unknown };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
};

/**
 * `codex exec --json` flags verified in https://developers.openai.com/codex/cli/reference.
 * The JSONL event schema (item.completed / turn.completed) is parsed tolerantly: UNVERIFIED on a live run.
 */
export const codexAdapter: ProviderAdapter = {
  id: "codex",
  executables: ["codex"],
  sbxAgent: "codex",
  buildCommand(spec: AgentRunSpec): BuiltCommand {
    const sandbox = spec.readOnly ? "read-only" : spec.sandboxed ? "danger-full-access" : "workspace-write";
    const argv = ["codex", "exec", "--json", "--skip-git-repo-check", "-m", spec.model, "-s", sandbox, "-c", `model_reasoning_effort="${spec.effort}"`, "-C", spec.cwd];
    if (spec.factoryMcpUrl) argv.push("-c", `mcp_servers.factory.url="${spec.factoryMcpUrl}"`);
    argv.push("-");
    const prompt = spec.systemPrompt ? `${spec.systemPrompt}\n\n---\n\n${spec.prompt}` : spec.prompt;
    return { argv, stdin: prompt };
  },
  parseLine(line: string): AgentEvent[] {
    let ev: Ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return [];
    }
    if (ev.type === "item.completed" && ev.item) {
      if (ev.item.type === "agent_message" && ev.item.text) return [{ type: "text", text: ev.item.text }];
      if (ev.item.type === "command_execution") return [{ type: "tool_call", name: "shell", input: { command: ev.item.command } }];
      if (ev.item.type === "file_change") return [{ type: "tool_call", name: "file_change", input: ev.item.changes }];
    }
    if (ev.type === "turn.completed") {
      return [
        { type: "usage", inputTokens: ev.usage?.input_tokens ?? 0, outputTokens: ev.usage?.output_tokens ?? 0 },
        { type: "done", ok: true, summary: "" },
      ];
    }
    if (ev.type === "turn.failed" || ev.type === "error") return [{ type: "done", ok: false, summary: ev.message ?? "codex failed" }];
    return [];
  },
};
