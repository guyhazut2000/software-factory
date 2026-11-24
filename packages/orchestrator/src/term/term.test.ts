import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Db } from "../db.js";
import { Hub } from "../hub.js";
import { Engine } from "../engine.js";
import { startServers } from "../server.js";
import { loadPty, ReplayBuffer, TermRegistry } from "./pty.js";

const hasPty = !!loadPty();
const win = process.platform === "win32";
const echo = (marker: string) => (win ? `echo ${marker}\r` : `echo ${marker}\n`);

describe("ReplayBuffer", () => {
  it("keeps only the newest bytes up to the cap", () => {
    const r = new ReplayBuffer(10);
    r.push("abcdef");
    r.push("ghijkl");
    expect(r.snapshot().toString()).toBe("ghijkl");
    r.push("0123456789XYZ");
    expect(r.snapshot().toString()).toBe("3456789XYZ");
    expect(r.snapshot().length).toBe(10);
  });
});

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

/** Resolves with the HTTP status of a refused upgrade, or 101 if it opened. */
const upgradeStatus = (url: string, headers: Record<string, string> = {}) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(0));
  });

describe("terminal API", () => {
  it("reports availability and enforces the project-workspace cwd allowlist", async () => {
    const st = await call("GET", "/api/term");
    expect(st.json).toMatchObject({ available: hasPty, sessions: [] });
    expect((await call("POST", "/api/term", {})).status).toBe(400);
    expect((await call("POST", "/api/term", { workspace: "p-nope" })).status).toBe(404);
    const dir = mkdtempSync(path.join(tmpdir(), "sf-term-"));
    const f = (await call("POST", "/api/projects", { kind: "folder", root_path: dir })).json;
    expect((await call("POST", "/api/term", { workspace: `p-${f.id}`, path: "../" })).status).toBe(400);
    expect((await call("POST", "/api/term", { workspace: `p-${f.id}`, path: win ? "C:\\" : "/etc" })).status).toBe(400);
    expect((await call("POST", "/api/term", { workspace: `m-${f.id}` })).status).toBe(404); // non-git folder: no "my workspace"
    expect(await upgradeStatus(`ws://127.0.0.1:${srv.apiPort}/term?session=nope&token=t`)).toBe(403);
    expect(await upgradeStatus(`ws://127.0.0.1:${srv.apiPort}/term?session=nope&token=bad`)).toBe(0);
    await call("DELETE", `/api/projects/${f.id}`);
  });

  it.skipIf(!hasPty)("runs a shell in a workspace, streams over /term, replays on reconnect, checks Origin and Host", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-term-"));
    mkdirSync(path.join(dir, "sub"));
    const f = (await call("POST", "/api/projects", { kind: "folder", root_path: dir })).json;
    const s = await call("POST", "/api/term", { workspace: `p-${f.id}`, path: "sub", cols: 100, rows: 30 });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ cols: 100, rows: 30, exited: null });
    expect(s.json.cwd.endsWith("sub")).toBe(true);
    const url = `ws://127.0.0.1:${srv.apiPort}/term?session=${s.json.id}&token=t`;
    expect(await upgradeStatus(url, { origin: "https://evil.example" })).toBe(403);
    expect(await upgradeStatus(url, { host: "evil.example" })).toBe(403);

    const read = (ws: WebSocket, marker: string) =>
      new Promise<string>((resolve, reject) => {
        let out = "";
        const t = setTimeout(() => reject(new Error(`timeout; got: ${out}`)), 15000);
        ws.on("message", (d, bin) => {
          if (!bin) return;
          out += d.toString();
          if (out.split(marker).length > 2 || (out.includes(marker) && !out.includes(`echo ${marker}`))) {
            clearTimeout(t);
            resolve(out);
          }
        });
      });
    const ws = new WebSocket(url, { headers: { origin: base } });
    await new Promise((r) => ws.on("open", r));
    const got = read(ws, "SF_PTY_OK");
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    ws.send(Buffer.from(echo("SF_PTY_OK")), { binary: true });
    expect(await got).toContain("SF_PTY_OK");
    ws.close();
    expect((await call("GET", "/api/term")).json.sessions[0]).toMatchObject({ cols: 120, rows: 40 });

    const ws2 = new WebSocket(url);
    const replay = new Promise<string>((r) => ws2.once("message", (d) => r(d.toString())));
    expect(await replay).toContain("SF_PTY_OK");
    ws2.close();

    expect((await call("DELETE", `/api/term/${s.json.id}`)).status).toBe(200);
    expect((await call("GET", "/api/term")).json.sessions).toEqual([]);
    await call("DELETE", `/api/projects/${f.id}`);
  }, 30000);

  it.skipIf(!hasPty)("caps the number of sessions and reports exits", async () => {
    const reg = new TermRegistry(1);
    const shell = win ? { file: process.env.COMSPEC || "cmd.exe", args: ["/c", "exit 3"] } : { file: "/bin/sh", args: ["-c", "exit 3"] };
    const s = reg.create({ cwd: tmpdir(), workspace_id: "x", shell });
    expect(() => reg.create({ cwd: tmpdir(), workspace_id: "x", shell })).toThrow(/too many/);
    await new Promise<void>((r) => {
      const i = setInterval(() => {
        if (s.exited !== null) {
          clearInterval(i);
          r();
        }
      }, 50);
    });
    expect(s.exited).toBe(3);
    reg.killAll();
    expect(reg.list()).toEqual([]);
  }, 20000);
});

describe("agent shell route", () => {
  it("POST /api/term/agent/:id returns 409 for an agent that is not running", async () => {
    const r = await call("POST", "/api/term/agent/nope", {});
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/not running/);
  });
});
