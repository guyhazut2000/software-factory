import { describe, expect, it } from "vitest";
import { activityQuery, groupByProject, heartbeatTone, type ActivityRow } from "./activity";

const row = (project: string | null, run_id: string) => ({ project, run_id }) as ActivityRow;

describe("activity helpers", () => {
  it("heartbeatTone uses the stuck threshold", () => {
    const now = 10 * 60_000;
    expect(heartbeatTone(null, now, 10)).toBe("danger");
    expect(heartbeatTone(now - 60_000, now, 10)).toBe("ok");
    expect(heartbeatTone(now - 6 * 60_000, now, 10)).toBe("warn");
    expect(heartbeatTone(now - 11 * 60_000, now, 10)).toBe("danger");
  });
  it("groupByProject sorts names and puts no-project last", () => {
    const g = groupByProject([row(null, "1"), row("b", "2"), row("a", "3"), row("b", "4")]);
    expect(g.map((x) => x.project)).toEqual(["a", "b", "No project"]);
    expect(g[1].rows.map((r) => r.run_id)).toEqual(["2", "4"]);
  });
  it("activityQuery builds filters", () => {
    expect(activityQuery({})).toBe("/api/activity");
    expect(activityQuery({ project: "p1", agent: "a 1", limit: 50 })).toBe("/api/activity?project=p1&agent=a+1&limit=50");
  });
});
