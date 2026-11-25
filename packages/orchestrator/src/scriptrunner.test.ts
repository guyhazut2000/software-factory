import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "./db.js";
import { Hub } from "./hub.js";
import { Engine } from "./engine.js";
import { startServers } from "./server.js";
import { TaskMirror } from "./taskmirror.js";
import { AutomationMirror, createAutomation } from "./automirror.js";
import { ScriptRunner, resolveCwd } from "./scriptrunner.js";
import { sandboxNameForRun, sbxCreateMountArgs } from "./workspace.js";
import type { ExecDeps } from "./scriptrunner.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "sfrun-"));

const wait = async (db: Db, id: string) => {
  for (let i = 0; i < 80; i++) {
    const r = db.get("SELECT * FROM runs WHERE id=?", id);
    if (r?.ended_at) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("run did not finish");
};

describe("script runner", () => {
  it("builds a direct-mount sbx create command", () => {
    expect(sbxCreateMountArgs({ name: "sf-r-abcd1234", dir: "/proj" })).toEqual(["create", "--name", "sf-r-abcd1234", "claude", "/proj"]);
    expect(sbxCreateMountArgs({ name: "x", extras: ["/lib:ro"] })).toEqual(["create", "--name", "x", "claude", "/lib:ro"]);
    expect(sandboxNameForRun("abcdefghijkl")).toBe("sf-r-abcdefgh");
  });

  it("keeps cwd inside the project folder", () => {
    const dir = tmp();
    expect(resolveCwd(dir, null)).toBe(realpathSync(dir));
    expect(() => resolveCwd(dir, path.join(dir, ".."))).toThrow(/inside the project folder/);
  });

  it("runs a host command, streams logs, and records history", async () => {
    const db = new Db(":memory:");
    db.setSetting("allow_worktree", true);
    const hub = new Hub();
    const runner = new ScriptRunner(db, hub, () => ({ allow_worktree: true }));
    const dir = tmp();
    db.insert("projects", { id: "p1", name: "Data", kind: "folder", root_path: dir, created_at: 1 });
    const auto = createAutomation(db, null, { name: "hello", project_id: "p1", kind: "command", command: "node", args: ["-e", "process.stdout.write('hi\\n')"], runner: "host", timeout_sec: 15 });
    const logs: string[] = [];
    hub.on("event", (e: { type: string; text?: string }) => { if (e.type === "log" && e.text) logs.push(e.text); });
    const run = runner.start(auto.id);
    expect(run).toMatchObject({ kind: "script", runner: "host", automation_id: auto.id, agent_id: null, ended_at: null });
    const done = await wait(db, run.id);
    expect(done.exit_reason).toBe("ok");
    const ev = db.all("SELECT kind, text FROM events WHERE run_id=? ORDER BY id", run.id);
    expect(ev.some((e) => e.kind === "stdout" && e.text === "hi")).toBe(true);
    expect(ev[0]).toMatchObject({ kind: "system" });
    expect(logs.some((t) => t === "hi")).toBe(true);
    expect(db.all("SELECT id FROM runs WHERE automation_id=?", auto.id)).toHaveLength(1);
  });

  it("refuses host runs when the worktree fallback is off, and agent kind", () => {
    const db = new Db(":memory:");
    const dir = tmp();
    db.insert("projects", { id: "p1", name: "Data", kind: "folder", root_path: dir, created_at: 1 });
    const runner = new ScriptRunner(db, new Hub(), () => ({ allow_worktree: false }));
    const host = createAutomation(db, null, { name: "h", project_id: "p1", command: "echo", runner: "host" });
    expect(() => runner.start(host.id)).toThrow(/Host runner is disabled/);
    const agent = createAutomation(db, null, { name: "ag", project_id: "p1", kind: "agent", command: "prompt", runner: "sbx" });
    expect(() => runner.start(agent.id)).toThrow(/cannot be run yet/);
  });

  it("times out a hung host command", async () => {
    const db = new Db(":memory:");
    const dir = tmp();
    db.insert("projects", { id: "p1", name: "Data", kind: "folder", root_path: dir, created_at: 1 });
    const runner = new ScriptRunner(db, new Hub(), () => ({ allow_worktree: true }));
    const auto = createAutomation(db, null, { name: "hang", project_id: "p1", command: "node", args: ["-e", "setTimeout(()=>{}, 30000)"], runner: "host", timeout_sec: 1 });
    const run = runner.start(auto.id);
    const done = await wait(db, run.id);
    expect(done.exit_reason).toBe("timeout");
  });

  it("creates an sbx mount sandbox, execs, then removes it", async () => {
    const db = new Db(":memory:");
    const dir = tmp();
    db.insert("projects", { id: "p1", name: "Data", kind: "folder", root_path: dir, created_at: 1 });
    const runner = new ScriptRunner(db, new Hub(), () => ({ allow_worktree: false }));
    const auto = createAutomation(db, null, { name: "sbx-echo", project_id: "p1", command: "echo", args: ["ok"], runner: "sbx", timeout_sec: 15 });
    const calls: string[][] = [];
    const deps: Partial<ExecDeps> = {
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
      stream: (argv, o) => {
        calls.push(argv);
        o.onLine("ok", false);
        return { child: {} as never, done: Promise.resolve(0), kill: () => {} };
      },
    };
    const run = runner.start(auto.id, deps);
    const done = await wait(db, run.id);
    expect(done.exit_reason).toBe("ok");
    expect(calls[0]!.slice(0, 5)).toEqual(["sbx", "create", "--name", sandboxNameForRun(run.id), "claude"]);
    expect(calls[0]!.at(-1)).toBe(realpathSync(dir));
    expect(calls.some((c) => c[0] === "sbx" && c[1] === "exec")).toBe(true);
    expect(calls.some((c) => c[1] === "rm")).toBe(true);
    expect(db.all("SELECT text FROM events WHERE run_id=? AND kind='stdout'", run.id)[0]?.text).toBe("ok");
  });
});

describe("automations api", () => {
  const db = new Db(":memory:");
  const dir = tmp();
  const engine = new Engine(db, new Hub());
  engine.mirror = new TaskMirror(db, dir, 10_000);
  engine.automirror = new AutomationMirror(db, engine.mirror);
  engine.db.setSetting("allow_worktree", true);
  const srvP = startServers(engine, { apiPort: 0, agentPort: 0, token: "t", agentBind: "127.0.0.1" });
  const call = async (method: string, p: string, body?: unknown) => {
    const srv = await srvP;
    const r = await fetch(`http://127.0.0.1:${srv.apiPort}` + p, { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  afterAll(async () => (await srvP).close());

  it("creates, lists, runs on the host, and returns streamed history", async () => {
    const proj = (await call("POST", "/api/projects", { kind: "folder", root_path: dir, name: "Data" })).json;
    const created = await call("POST", "/api/automations", { name: "api-hello", project_id: proj.id, command: "node", args: ["-e", "process.stdout.write('api\\n')"], runner: "host", timeout_sec: 15 });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ name: "api-hello", runner: "host", kind: "command" });
    expect((await call("GET", "/api/automations")).json.map((a: { name: string }) => a.name)).toContain("api-hello");
    const run = await call("POST", `/api/automations/${created.json.id}/run`);
    expect(run.status).toBe(200);
    expect(run.json.kind).toBe("script");
    let got;
    for (let i = 0; i < 80; i++) {
      got = (await call("GET", `/api/runs/${run.json.id}`)).json;
      if (got.run.ended_at) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(got.run.exit_reason).toBe("ok");
    expect(got.events.some((e: { text: string }) => e.text === "api")).toBe(true);
    expect((await call("GET", `/api/automations/${created.json.id}/runs`)).json).toHaveLength(1);
    expect((await call("GET", "/api/state")).json.automations.some((a: { name: string }) => a.name === "api-hello")).toBe(true);
  });
});
