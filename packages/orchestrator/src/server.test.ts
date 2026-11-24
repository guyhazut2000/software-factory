import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "./db.js";
import { Hub } from "./hub.js";
import { Engine } from "./engine.js";
import { startServers } from "./server.js";

const db = new Db(":memory:");
const engine = new Engine(db, new Hub());
engine.applySettings();
const srv = await startServers(engine, { apiPort: 0, agentPort: 0, token: "t", agentBind: "127.0.0.1" });
const base = `http://127.0.0.1:${srv.apiPort}`;
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
afterAll(() => srv.close());

describe("api", () => {
  it("requires the token", async () => {
    expect((await fetch(base + "/api/state")).status).toBe(401);
  });
  it("creates agents from templates, edits, toggles, clones, deletes", async () => {
    const a = (await call("POST", "/api/agents", { template: "developer" })).json;
    expect(a.role).toBe("developer");
    expect(a.permissions).toEqual(["open_pr"]);
    await call("PUT", `/api/agents/${a.id}`, { model: "opus", skills: ["x-skill"] });
    await call("POST", `/api/agents/${a.id}/toggle`, { on: true });
    let st = (await call("GET", "/api/state")).json;
    const got = st.agents.find((x: { id: string }) => x.id === a.id);
    expect(got.model).toBe("opus");
    expect(got.enabled).toBe(true);
    expect(got.state).toBe("idle");
    const c = (await call("POST", `/api/agents/${a.id}/clone`)).json;
    expect(c.name).toContain("copy");
    expect(c.enabled).toBe(false);
    await call("DELETE", `/api/agents/${c.id}`);
    st = (await call("GET", "/api/state")).json;
    expect(st.agents).toHaveLength(1);
  });
  it("settings: modes and cap apply to the scheduler", async () => {
    await call("PUT", "/api/settings", { mode: "eco" });
    expect(engine.scheduler.cap).toBe(1);
    await call("PUT", "/api/settings", { mode: "full", cap: 5 });
    expect(engine.scheduler.cap).toBe(5);
    await call("PUT", "/api/settings", { mode: "quiet" });
    expect(engine.scheduler.cap).toBe(0);
    await call("PUT", "/api/settings", { mode: "full", cap: 3 });
  });
  it("stop-all and resume toggle the flag", async () => {
    await call("POST", "/api/stop-all");
    expect(engine.settings().stopped).toBe(true);
    await call("POST", "/api/resume");
    expect(engine.settings().stopped).toBe(false);
  });
  it("health reports dependencies", async () => {
    const h = (await call("GET", "/api/health")).json as { id: string }[];
    expect(h.map((x) => x.id)).toEqual(expect.arrayContaining(["node", "git", "github", "claude", "codex", "cursor-agent"]));
  });
  it("creates folder and none projects without GitHub", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-proj-"));
    const f = await call("POST", "/api/projects", { kind: "folder", root_path: dir });
    expect(f.status).toBe(200);
    expect(f.json).toMatchObject({ kind: "folder", repo: null, root_path: realpathSync(dir), name: path.basename(realpathSync(dir)) });
    expect((await call("POST", "/api/projects", { kind: "folder", root_path: dir })).status).toBe(400);
    expect((await call("POST", "/api/projects", { kind: "folder", root_path: "relative/x" })).status).toBe(400);
    expect((await call("POST", "/api/projects", { kind: "folder", root_path: path.join(dir, "missing") })).status).toBe(400);
    const n = await call("POST", "/api/projects", { kind: "none", name: "Personal" });
    expect(n.json).toMatchObject({ kind: "none", repo: null, root_path: null, name: "Personal" });
    expect((await call("POST", "/api/tasks", { project_id: n.json.id, title: "x" })).status).toBe(400);
    const st = (await call("GET", "/api/state")).json;
    expect(st.projects.map((p: { kind: string }) => p.kind)).toEqual(expect.arrayContaining(["folder", "none"]));
    await call("DELETE", `/api/projects/${f.json.id}`);
    await call("DELETE", `/api/projects/${n.json.id}`);
  });
  it("IDE routes: list workspaces, browse a folder project, refuse escapes and foreign Host headers", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-wsapi-"));
    writeFileSync(path.join(dir, "notes.md"), "hello");
    const f = (await call("POST", "/api/projects", { kind: "folder", root_path: dir })).json;
    const wid = `p-${f.id}`;
    expect((await call("GET", "/api/ws")).json.map((w: { id: string }) => w.id)).toContain(wid);
    expect((await call("GET", `/api/ws/${wid}/tree`)).json.map((e: { name: string }) => e.name)).toEqual(["notes.md"]);
    expect((await call("GET", `/api/ws/${wid}/file?path=notes.md`)).json).toMatchObject({ content: "hello", language: "markdown" });
    expect((await call("GET", `/api/ws/${wid}/file?path=../x`)).status).toBe(400);
    expect((await call("GET", `/api/ws/${wid}/git/log`)).json).toEqual([]);
    expect((await call("GET", `/api/ws/p-nope/tree`)).status).toBe(404);
    expect((await call("GET", `/api/ws/..%2F..%2Fetc/tree`)).status).toBe(400);
    const r = await new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: srv.apiPort, path: `/api/ws/${wid}/tree`, headers: { host: "evil.example", authorization: "Bearer t" } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(r).toBe(403);
    await call("DELETE", `/api/projects/${f.id}`);
  });
  it("agent listener rejects unknown runs", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.agentPort}/mcp/nope`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });
});
