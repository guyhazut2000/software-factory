import { describe, expect, it, vi } from "vitest";
import { agentLogs, agentMessages, clampWidth, DRAWER_MIN, DRAWER_TABS, onOpenAgent, openAgent, recreateHint, taskWorkspace } from "./drawer";
import type { LogEvent, Message } from "./types";

describe("agent drawer helpers", () => {
  it("has the seven tabs in order", () => {
    expect(DRAWER_TABS).toEqual(["overview", "settings", "terminal", "files", "diff", "messages", "log"]);
  });
  it("clamps width", () => {
    expect(clampWidth(100, 1000)).toBe(DRAWER_MIN);
    expect(clampWidth(5000, 1000)).toBe(900);
    expect(clampWidth(500, 1000)).toBe(500);
    expect(clampWidth(500, 300)).toBe(DRAWER_MIN);
  });
  it("filters messages to and from the agent, oldest first", () => {
    const m = (id: string, from: string | null, to: string | null, at: number): Message => ({ id, from_id: from, to_id: to, body: id, created_at: at });
    const out = agentMessages([m("a", "x", null, 3), m("b", null, "x", 1), m("c", "y", "z", 2)], "x");
    expect(out.map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("keeps the newest agent log lines", () => {
    const l = (agent_id: string, ts: number): LogEvent => ({ run_id: "r", task_id: null, agent_id, kind: "k", text: "t", ts });
    expect(agentLogs([l("x", 1), l("y", 2), l("x", 3), l("x", 4)], "x", 2).map((e) => e.ts)).toEqual([3, 4]);
  });
  it("maps a task to its IDE workspace", () => {
    expect(taskWorkspace("42")).toBe("t-42");
    expect(taskWorkspace(null)).toBeNull();
  });
  it("opens via a window event", () => {
    const fn = vi.fn();
    const off = onOpenAgent(fn);
    openAgent("a1", "diff");
    off();
    openAgent("a2");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ id: "a1", tab: "diff" });
  });
  it("explains what recreate sandbox will do", () => {
    const a = { cpu: 4, ram_mb: 8192 };
    expect(recreateHint({ ...a, current_task_id: null, state: "idle" })).toMatch(/No task/);
    expect(recreateHint({ ...a, current_task_id: "t1", state: "running" })).toMatch(/Restarts.*4 CPU \/ 8192 MB/);
    expect(recreateHint({ ...a, current_task_id: "t1", state: "idle" })).toMatch(/Removes/);
  });
});
