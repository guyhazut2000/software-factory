import { describe, it, expect } from "vitest";
import { parseNpmAudit, parseSemgrep, parseGitleaks, parseEslint } from "./scanners.js";

describe("scanner parsers", () => {
  it("npm audit keeps high/critical only", () => {
    const f = parseNpmAudit(JSON.stringify({ vulnerabilities: { a: { severity: "high" }, b: { severity: "low" } } }));
    expect(f).toHaveLength(1);
  });
  it("semgrep", () => expect(parseSemgrep(JSON.stringify({ results: [{ check_id: "x", path: "a.js", start: { line: 3 }, extra: { message: "m", severity: "ERROR" } }] }))[0].summary).toContain("a.js:3"));
  it("gitleaks", () => expect(parseGitleaks(JSON.stringify([{ RuleID: "aws", File: "f", StartLine: 1 }]))).toHaveLength(1));
  it("eslint errors only", () => expect(parseEslint(JSON.stringify([{ filePath: "/a/b.ts", messages: [{ severity: 2, line: 1, ruleId: "r", message: "m" }, { severity: 1, line: 2, ruleId: "w", message: "w" }] }]))).toHaveLength(1));
  it("bad json is safe", () => expect(parseSemgrep("oops")).toEqual([]));
});
