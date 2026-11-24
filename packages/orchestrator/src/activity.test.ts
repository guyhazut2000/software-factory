import { describe, it, expect, afterAll } from "vitest";
import { WebSocket } from "ws";
import { Db } from "./db.js";
import { Hub } from "./hub.js";
import { Engine } from "./engine.js";
import { startServers } from "./server.js";
import { activity, sandboxName } from "./activity.js";

const db = new Db(":memory:");
db.insert("projects", { id: "p1", name: "Proj", kind: "none", created_at: 1 });
db.insert("projects", { id: "p2", name: "Other", kind: "none", created_at: 1 });
db.insert("agents", { id: "a1", name: "dev", role: "developer", provider: "claude", model: "m", state: "working", created_at: 1 });
db.insert("tasks", { id: "task12345678", project_id: "p1", source: "local", type: "code", title: "T1", status: "in_progress", branch: "sf/t1", pr_number: 7, created_at: 1, updated_at: 1 });
db.insert("tasks", { id: "task2", project_id: "p2", source: "local", type: "script", title: "T2", status: "done", created_at: 1, updated_at: 1 });
db.insert("runs", { id: "r1", task_id: "task12345678", agent_id: "a1", kind: "dev", runner: "sbx", started_at: 10, last_heartbeat_at: 20, tokens: 5 });
db.insert("runs", { id: "r2", task_id: "task2", agent_id: "a1", kind: "script", runner: "worktree", started_at: 1, ended_at: 5, exit_reason: "ok" });
db.insert("events", { run_id: "r1", ts: 11, kind: "system", text: "first" });
db.insert("events", { run_id: "r1", ts: 12, kind: "agent", text: "latest" });

describe("activity", () => {
  it("joins live runs and history", () => {
    const a = activity(db);
    expect(a.live).toHaveLength(1);
    expect(a.live[0]).toMatchObject({ agent: "dev", state: "working", project: "Proj", task: "T1", task_type: "code", branch: "sf/t1", pr: 7, runner: "sbx", sandbox_name: "sf-task1234", last_heartbeat_at: 20, tokens: 5 });
    expect(a.live[0].last_event).toMatchObject({ text: "latest" });
    expect(a.history).toHaveLength(1);
    expect(a.history[0]).toMatchObject({ run_id: "r2", task_type: "script", sandbox_name: null, exit_reason: "ok" });
  });
  it("filters by project and agent", () => {
    expect(activity(db, { project: "p2" }).live).toHaveLength(0);
    expect(activity(db, { project: "p2" }).history).toHaveLength(1);
    expect(activity(db, { agent: "nope" }).history).toHaveLength(0);
    expect(sandboxName("worktree", "x")).toBeNull();
  });
  it("serves GET /api/activity and pushes a WebSocket activity event", async () => {
    const hub = new Hub();
    const engine = new Engine(db, hub);
    engine.applySettings();
    const srv = await startServers(engine, { apiPort: 0, agentPort: 0, token: "t", agentBind: "127.0.0.1" });
    afterAll(() => srv.close());
    const r = await fetch(`http://127.0.0.1:${srv.apiPort}/api/activity?project=p1`, { headers: { authorization: "Bearer t" } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.live[0].run_id).toBe("r1");
    expect(j.history).toHaveLength(0);
    const ws = new WebSocket(`ws://127.0.0.1:${srv.apiPort}/ws?token=t`);
    await new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
    const got = new Promise<{ type: string; live: unknown[] }>((res) => ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "activity") res(m); }));
    hub.emitEvent({ type: "tasks" });
    const m = await got;
    expect(m.live).toHaveLength(1);
    ws.close();
  });
});
