import { describe, it, expect } from "vitest";
import { transition } from "./state-machine.js";
import { Scheduler } from "./scheduler.js";

describe("state machine", () => {
  it("happy path incl. ask", () => {
    let s = transition("off", "enable");
    s = transition(s, "assign");
    s = transition(s, "ask");
    s = transition(s, "answer");
    expect(transition(s, "finish")).toBe("idle");
  });
  it("restart path", () => {
    expect(transition(transition(transition("working", "stall"), "restart"), "restarted")).toBe("working");
  });
  it("rejects invalid", () => expect(() => transition("off", "assign")).toThrow());
});

describe("scheduler", () => {
  it("caps concurrency and promotes the queue", () => {
    const s = new Scheduler(2);
    expect(s.request("a")).toBe(true);
    expect(s.request("b")).toBe(true);
    expect(s.request("c")).toBe(false);
    expect(s.release("a")).toBe("c");
  });
  it("cap can change", () => {
    const s = new Scheduler(1);
    s.request("a");
    s.cap = 3;
    expect(s.request("b")).toBe(true);
  });
});
