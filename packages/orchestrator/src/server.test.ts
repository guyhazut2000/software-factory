import { describe, it, expect, afterAll } from "vitest";
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
  it("agent listener rejects unknown runs", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.agentPort}/mcp/nope`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });
});
