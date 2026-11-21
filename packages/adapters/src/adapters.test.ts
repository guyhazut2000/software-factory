import { describe, it, expect } from "vitest";
import { claudeCodeAdapter, codexAdapter, cursorAdapter, getAdapter } from "./index.js";

const spec = { prompt: "hi", systemPrompt: "sp", model: "sonnet", effort: "low" as const, cwd: "/w", sandboxed: true };

describe("adapters", () => {
  it("claude: non-interactive stream-json, prompt on stdin", () => {
    const c = claudeCodeAdapter.buildCommand(spec);
    expect(c.argv.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(c.argv).toContain("stream-json");
    expect(c.argv).toContain("bypassPermissions");
    expect(c.stdin).toBe("hi");
  });
  it("claude: unsandboxed uses restricted tools; readOnly uses allowlist", () => {
    expect(claudeCodeAdapter.buildCommand({ ...spec, sandboxed: false }).argv).toContain("acceptEdits");
    expect(claudeCodeAdapter.buildCommand({ ...spec, readOnly: true }).argv.join(" ")).toContain("mcp__factory Read");
  });
  it("claude: parses assistant + result", () => {
    const a = claudeCodeAdapter.parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }, { type: "tool_use", name: "Edit", input: {} }], usage: { input_tokens: 5, output_tokens: 7 } } }));
    expect(a.map((e) => e.type)).toEqual(["text", "tool_call", "usage"]);
    const r = claudeCodeAdapter.parseLine(JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0.1 }));
    expect(r.at(-1)).toEqual({ type: "done", ok: true, summary: "ok" });
  });
  it("codex: exec --json with sandbox and effort", () => {
    const c = codexAdapter.buildCommand({ ...spec, factoryMcpUrl: "http://h/mcp/t" });
    expect(c.argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(c.argv).toContain("danger-full-access");
    expect(c.argv.join(" ")).toContain("mcp_servers.factory.url");
  });
  it("codex: parses events", () => {
    expect(codexAdapter.parseLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "t" } }))).toEqual([{ type: "text", text: "t" }]);
  });
  it("cursor: print mode stream-json", () => {
    const c = cursorAdapter.buildCommand({ ...spec, factoryMcpUrl: "http://h/mcp/t" });
    expect(c.argv).toContain("--force");
    expect(c.files?.[".cursor/mcp.json"]).toContain("factory");
  });
  it("ignores garbage and rejects unknown provider", () => {
    expect(claudeCodeAdapter.parseLine("not json")).toEqual([]);
    expect(() => getAdapter("nope")).toThrow();
  });
});
