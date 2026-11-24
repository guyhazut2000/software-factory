import { describe, expect, it } from "vitest";
import { sourceBadge } from "./tasks";

describe("sourceBadge", () => {
  it("labels github, manual and local code tasks", () => {
    expect(sourceBadge({ source: "github", type: "code", issue_number: 7 })).toEqual({ label: "GitHub #7", tone: "primary" });
    expect(sourceBadge({ source: "local", type: "manual", issue_number: null })).toEqual({ label: "manual", tone: "warn" });
    expect(sourceBadge({ source: "local", type: "code", issue_number: null })).toEqual({ label: "local code", tone: "muted" });
  });
});
