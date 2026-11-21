import type { AgentEvent, AgentRunSpec, ProviderAdapter } from "./types.js";

export const claudeCodeAdapter: ProviderAdapter = {
  id: "claude-code",
  buildCommand(spec: AgentRunSpec) {
    return [
      "claude",
      "-p",
      spec.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      spec.model,
      "--append-system-prompt",
      spec.systemPrompt,
    ];
  },
  parseLine(line: string): AgentEvent[] {
    let msg: { type?: string; message?: { content?: { type: string; text?: string }[] }; usage?: { input_tokens?: number; output_tokens?: number }; total_cost_usd?: number; result?: string; is_error?: boolean };
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    if (msg.type === "assistant") {
      return (msg.message?.content ?? [])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => ({ type: "text" as const, text: c.text! }));
    }
    if (msg.type === "result") {
      return [
        { type: "usage", inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0, usd: msg.total_cost_usd },
        { type: "done", ok: !msg.is_error, summary: msg.result ?? "" },
      ];
    }
    return [];
  },
};
