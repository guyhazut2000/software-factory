import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Workspace } from "../workspace.js";
import { loadPty, TermRegistry } from "./pty.js";
import { openAgentShell, type AgentLookup } from "./agent.js";

const win = process.platform === "win32";
const hasPty = !!loadPty();
const dir = mkdtempSync(path.join(tmpdir(), "sf-fake-sbx-"));
const ws = (kind: "sbx" | "worktree", sandbox?: string) => ({ kind, sandbox, hostDir: dir, cwd: dir }) as unknown as Workspace;
const lookup = (w?: Workspace): AgentLookup => (id) => (id === "a1" ? { ws: w, agent: { id: "a1", name: "dev" }, task: { id: "t1", title: "Fix" } } : undefined);
const status = async (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);
const terms = new TermRegistry();
const waitFor = async (f: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (f()) return true;
  return false;
};
afterAll(() => terms.killAll());

describe("openAgentShell", () => {
  it("409 when the agent is not running or its workspace is not ready", async () => {
    expect(await status(openAgentShell(terms, lookup(), "nope", {}))).toBe(409);
    expect(await status(openAgentShell(terms, lookup(undefined), "a1", {}))).toBe(409);
  });

  it("503 when sbx is not on PATH", async () => {
    const old = process.env.PATH;
    process.env.PATH = path.join(dir, "empty");
    try {
      expect(await status(openAgentShell(terms, lookup(ws("sbx", "sf-t1")), "a1", {}))).toBe(503);
    } finally {
      process.env.PATH = old;
    }
  });

  it.skipIf(!hasPty)("worktree agents get a host shell in their worktree", async () => {
    const s = await openAgentShell(terms, lookup(ws("worktree")), "a1", {});
    expect(s.cwd).toBe(path.resolve(dir));
    expect(s.label).toContain("worktree");
    expect(s.workspace_id).toBe("agent:a1");
    terms.kill(s.id);
  });
});

describe.skipIf(win || !hasPty)("openAgentShell with a fake sbx binary", () => {
  const bin = path.join(dir, "bin");
  let old: string | undefined;
  beforeAll(() => {
    old = process.env.PATH;
    mkdirSync(bin, { recursive: true });
    const f = path.join(bin, "sbx");
    writeFileSync(f, `#!/bin/sh\nif [ "$1" = ls ]; then echo "NAME STATUS"; cat "${dir}/ls.txt"; exit 0; fi\necho "FAKE-SBX $*"\n`);
    chmodSync(f, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${old}`;
  });
  afterAll(() => void (process.env.PATH = old));

  it("409 when the sandbox is stopped or missing", async () => {
    writeFileSync(path.join(dir, "ls.txt"), "sf-t1 stopped\n");
    expect(await status(openAgentShell(terms, lookup(ws("sbx", "sf-t1")), "a1", {}))).toBe(409);
    writeFileSync(path.join(dir, "ls.txt"), "sf-other running\n");
    expect(await status(openAgentShell(terms, lookup(ws("sbx", "sf-t1")), "a1", {}))).toBe(409);
  });

  it("spawns `sbx exec -it <sandbox> <shell>` through the PTY service", async () => {
    writeFileSync(path.join(dir, "ls.txt"), "sf-t1 running\n");
    const s = await openAgentShell(terms, lookup(ws("sbx", "sf-t1")), "a1", { cols: 100, rows: 30 });
    expect(s.shell).toBe(path.join(bin, "sbx"));
    expect(s.cols).toBe(100);
    expect(await waitFor(() => s.replay.snapshot().toString().includes("FAKE-SBX exec -it sf-t1 sh -c"))).toBe(true);
    terms.kill(s.id);
  });
});
