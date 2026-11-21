import { describe, it, expect } from "vitest";
import { claudeCodeAdapter } from "./claude-code.js";

describe("claudeCodeAdapter", () => {
  it("builds a non-interactive command", () => {
    const cmd = claudeCodeAdapter.buildCommand({ prompt: "hi", systemPrompt: "sp", model: "sonnet", effort: "low", cwd: "/w", maxRuntimeSec: 60 });
    expect(cmd.slice(0, 3)).toEqual(["claude", "-p", "hi"]);
    expect(cmd).toContain("stream-json");
  });
  it("parses result lines", () => {
    const ev = claudeCodeAdapter.parseLine(JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 1, output_tokens: 2 } }));
    expect(ev.at(-1)).toEqual({ type: "done", ok: true, summary: "ok" });
  });
  it("ignores garbage", () => {
    expect(claudeCodeAdapter.parseLine("not json")).toEqual([]);
  });
});
