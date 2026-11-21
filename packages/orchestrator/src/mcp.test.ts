import { describe, it, expect } from "vitest";
import { handleMcp, TOOLS, type FactoryHost } from "./mcp.js";

const host = new Proxy({} as FactoryHost, { get: (_t, k) => async (...a: unknown[]) => `${String(k)}:${a.length}` });

describe("factory MCP", () => {
  it("initializes and lists tools", async () => {
    const i = (await handleMcp(host, "r", { jsonrpc: "2.0", id: 1, method: "initialize" })) as { result: { serverInfo: { name: string } } };
    expect(i.result.serverInfo.name).toBe("factory");
    const l = (await handleMcp(host, "r", { jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: unknown[] } };
    expect(l.result.tools).toHaveLength(TOOLS.length);
  });
  it("dispatches tool calls", async () => {
    const r = (await handleMcp(host, "r", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_guy", arguments: { question: "q?" } } })) as { result: { content: { text: string }[] } };
    expect(r.result.content[0].text).toBe("askGuy:2");
  });
  it("returns null for notifications and errors for unknown", async () => {
    expect(await handleMcp(host, "r", { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const e = (await handleMcp(host, "r", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x" } })) as { error: unknown };
    expect(e.error).toBeTruthy();
  });
});
