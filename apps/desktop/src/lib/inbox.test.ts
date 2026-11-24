import { describe, expect, it } from "vitest";
import { askOptions, groupAsks, threadLabel } from "./inbox";
import type { Question, Thread } from "./types";

const q = (id: string, agent_id: string, asked_at: number, extra: Partial<Question> = {}): Question => ({ id, agent_id, asked_at, task_id: null, project_id: null, body: id, ...extra });

describe("inbox helpers", () => {
  it("parses options safely", () => {
    expect(askOptions({ options: '["yes","no"]' })).toEqual(["yes", "no"]);
    expect(askOptions({ options: null })).toEqual([]);
    expect(askOptions({ options: "not json" })).toEqual([]);
    expect(askOptions({ options: '{"a":1}' })).toEqual([]);
  });
  it("groups open asks by agent, oldest first, skipping closed ones", () => {
    const g = groupAsks([q("b2", "b", 5), q("a1", "a", 3), q("b1", "b", 1), q("x", "a", 0, { status: "dismissed" })], [{ id: "a", name: "Ann" }, { id: "b", name: "Bob" }]);
    expect(g.map((x) => [x.name, x.asks.map((a) => a.id)])).toEqual([["Bob", ["b1", "b2"]], ["Ann", ["a1"]]]);
  });
  it("labels threads by kind", () => {
    const t = (kind: Thread["kind"], title = ""): Thread => ({ id: "t", agent_id: "a", project_id: "p", task_id: null, title, kind, status: "open", created_at: 0 });
    const an = () => "Ann", pn = () => "repo";
    expect(threadLabel(t("chief"), an, pn)).toBe("Chief · repo");
    expect(threadLabel(t("direct"), an, pn)).toBe("Direct · Ann");
    expect(threadLabel(t("ask", "Need key"), an, pn)).toBe("Need key");
  });
});
