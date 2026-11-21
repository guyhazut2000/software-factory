import { describe, it, expect } from "vitest";
import { transition } from "./state-machine.js";
import { Scheduler } from "./scheduler.js";

describe("state machine", () => {
  it("follows the happy path", () => {
    let s = transition("off", "enable");
    s = transition(s, "assign");
    s = transition(s, "ask");
    s = transition(s, "answer");
    expect(transition(s, "finish")).toBe("idle");
  });
  it("rejects invalid transitions", () => {
    expect(() => transition("off", "assign")).toThrow();
  });
});

describe("scheduler", () => {
  it("caps concurrency and promotes the queue", () => {
    const s = new Scheduler(2);
    expect(s.request("a")).toBe(true);
    expect(s.request("b")).toBe(true);
    expect(s.request("c")).toBe(false);
    expect(s.release("a")).toBe("c");
  });
});
