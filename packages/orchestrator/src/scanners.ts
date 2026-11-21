import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { run, which } from "./util.js";

export interface Finding {
  tool: string;
  summary: string;
}

const cap = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + "\n...[truncated]" : s);

export function parseNpmAudit(json: string): Finding[] {
  try {
    const j = JSON.parse(json);
    const out: Finding[] = [];
    for (const [name, v] of Object.entries<{ severity: string; range?: string }>(j.vulnerabilities ?? {})) {
      if (["high", "critical"].includes(v.severity)) out.push({ tool: "npm audit", summary: `${name} (${v.severity}) ${v.range ?? ""}`.trim() });
    }
    return out;
  } catch {
    return [];
  }
}

export function parseSemgrep(json: string): Finding[] {
  try {
    const j = JSON.parse(json);
    return (j.results ?? []).slice(0, 30).map((r: { check_id: string; path: string; start?: { line: number }; extra?: { message?: string; severity?: string } }) => ({
      tool: "semgrep",
      summary: `${r.extra?.severity ?? ""} ${r.path}:${r.start?.line ?? "?"} ${r.check_id} ${r.extra?.message ?? ""}`.trim(),
    }));
  } catch {
    return [];
  }
}

export function parseGitleaks(json: string): Finding[] {
  try {
    const j = JSON.parse(json);
    return (Array.isArray(j) ? j : []).slice(0, 30).map((r: { RuleID: string; File: string; StartLine: number }) => ({ tool: "gitleaks", summary: `${r.RuleID} in ${r.File}:${r.StartLine}` }));
  } catch {
    return [];
  }
}

export function parseEslint(json: string): Finding[] {
  try {
    const j = JSON.parse(json) as { filePath: string; messages: { severity: number; line: number; ruleId: string | null; message: string }[] }[];
    const out: Finding[] = [];
    for (const f of j) for (const m of f.messages) if (m.severity === 2) out.push({ tool: "eslint", summary: `${path.basename(f.filePath)}:${m.line} ${m.ruleId ?? ""} ${m.message}` });
    return out.slice(0, 40);
  } catch {
    return [];
  }
}

/** Run every free scanner that is available. Missing tools are reported, never fatal. */
export async function runScanners(dir: string): Promise<{ findings: Finding[]; ran: string[]; skipped: string[] }> {
  const findings: Finding[] = [];
  const ran: string[] = [];
  const skipped: string[] = [];
  const hasEslint = existsSync(path.join(dir, "node_modules/.bin/eslint")) && readdirSync(dir).some((f) => f.startsWith("eslint.config") || f.startsWith(".eslintrc"));
  if (hasEslint) {
    const r = await run("npx", ["--no-install", "eslint", ".", "-f", "json"], { cwd: dir, timeoutMs: 180_000 });
    findings.push(...parseEslint(r.stdout));
    ran.push("eslint");
  } else skipped.push("eslint (no config or deps installed)");
  if (which("semgrep")) {
    const r = await run("semgrep", ["scan", "--config", "auto", "--json", "--quiet"], { cwd: dir, timeoutMs: 300_000 });
    findings.push(...parseSemgrep(r.stdout));
    ran.push("semgrep");
  } else skipped.push("semgrep (not installed)");
  if (which("gitleaks")) {
    const report = path.join(os.tmpdir(), `gitleaks-${Date.now()}.json`);
    await run("gitleaks", ["detect", "--source", ".", "--no-banner", "--report-format", "json", "--report-path", report], { cwd: dir, timeoutMs: 180_000 });
    try {
      findings.push(...parseGitleaks(readFileSync(report, "utf8")));
    } catch {
      /* no report = no leaks */
    }
    ran.push("gitleaks");
  } else skipped.push("gitleaks (not installed)");
  if (existsSync(path.join(dir, "package-lock.json"))) {
    const r = await run("npm", ["audit", "--json", "--omit=dev"], { cwd: dir, timeoutMs: 120_000 });
    findings.push(...parseNpmAudit(r.stdout));
    ran.push("npm audit");
  } else skipped.push("npm audit (no package-lock.json)");
  return { findings, ran, skipped };
}

export function formatFindings(f: { findings: Finding[]; ran: string[]; skipped: string[] }): string {
  const lines = [`Scanners run: ${f.ran.join(", ") || "none"}. Skipped: ${f.skipped.join("; ") || "none"}.`];
  lines.push(f.findings.length ? f.findings.map((x) => `- [${x.tool}] ${x.summary}`).join("\n") : "No findings.");
  return cap(lines.join("\n"));
}
