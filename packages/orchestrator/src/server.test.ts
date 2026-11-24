import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { execFileSync } from "node:child_process";
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
    const lt = await call("POST", "/api/tasks", { project_id: n.json.id, title: "x" });
    expect(lt.json).toMatchObject({ source: "local", type: "manual", status: "queued", project_id: n.json.id });
    expect((await call("PUT", `/api/tasks/${lt.json.id}`, { title: "y" })).json).toMatchObject({ title: "y" });
    expect((await call("POST", `/api/tasks/${lt.json.id}/complete`, {})).status).toBe(200);
    expect((await call("POST", "/api/tasks", { title: "" })).status).toBe(400);
    const st = (await call("GET", "/api/state")).json;
    expect(st.projects.map((p: { kind: string }) => p.kind)).toEqual(expect.arrayContaining(["folder", "none"]));
    const dir2 = mkdtempSync(path.join(tmpdir(), "sf-proj2-"));
    expect((await call("PUT", `/api/projects/${f.json.id}`, { root_path: dir2, name: "Data" })).status).toBe(200);
    const fp = (await call("GET", "/api/state")).json.projects.find((p: { id: string }) => p.id === f.json.id);
    expect(fp).toMatchObject({ root_path: realpathSync(dir2), name: "Data" });
    expect((await call("PUT", `/api/projects/${f.json.id}`, { root_path: path.join(dir2, "gone") })).status).toBe(400);
    expect((await call("PUT", `/api/projects/${n.json.id}`, { root_path: dir2 })).status).toBe(400);
    expect((await call("PUT", `/api/projects/${n.json.id}`, { name: "Finance" })).status).toBe(200);
    expect((await call("PUT", `/api/projects/${n.json.id}`, { name: " " })).status).toBe(400);
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
    const cur = (await call("GET", `/api/ws/${wid}/file?path=notes.md`)).json;
    expect((await call("PUT", `/api/ws/${wid}/file?path=notes.md`, { content: "edited", base_sha: cur.sha256 })).status).toBe(200);
    expect(readFileSync(path.join(dir, "notes.md"), "utf8")).toBe("edited");
    expect((await call("PUT", `/api/ws/${wid}/file?path=notes.md`, { content: "y", base_sha: cur.sha256 })).status).toBe(409);
    expect((await call("GET", `/api/ws/..%2F..%2Fetc/tree`)).status).toBe(400);
    const r = await new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: srv.apiPort, path: `/api/ws/${wid}/tree`, headers: { host: "evil.example", authorization: "Bearer t" } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(r).toBe(403);
    rmSync(dir, { recursive: true, force: true });
    expect((await call("GET", "/api/ws")).json.find((w: { id: string }) => w.id === wid)).toMatchObject({ read_only: true, exists: false });
    expect((await call("PUT", `/api/ws/${wid}/file?path=n.md`, { content: "x", base_sha: null })).status).toBe(403);
    await call("DELETE", `/api/projects/${f.id}`);
  });
  it("IDE task workspace: diff of a pushed task branch against the default branch", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "sf-task-"));
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo }).toString().trim();
    g("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "app.js"), "v1\n");
    g("add", "-A");
    g("commit", "-qm", "base");
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    g("checkout", "-q", "-b", "sf/5-fix");
    writeFileSync(path.join(repo, "app.js"), "v2\n");
    g("commit", "-qam", "fix");
    g("update-ref", "refs/remotes/origin/sf/5-fix", "HEAD");
    g("checkout", "-q", "main");
    db.insert("projects", { id: "gp", name: "demo", kind: "github", repo: "me/ide-demo", root_path: repo, default_branch: "main", created_at: 1 });
    db.insert("tasks", { id: "tk1", project_id: "gp", source: "github", type: "code", external_ref: "5", title: "Fix", status: "in_review", branch: "sf/5-fix", created_at: 1, updated_at: 1 });
    const ws = (await call("GET", "/api/ws")).json.find((w: { id: string }) => w.id === "t-tk1");
    expect(ws).toMatchObject({ kind: "task", ref: "origin/sf/5-fix", read_only: true });
    expect((await call("GET", "/api/ws/t-tk1/file?path=app.js")).json.content).toBe("v2\n");
    // checked-out files may be CRLF on Windows (core.autocrlf); blobs from git are LF
    expect((await call("GET", "/api/ws/p-gp/file?path=app.js")).json.content.replace(/\r\n/g, "\n")).toBe("v1\n");
    expect((await call("GET", "/api/ws/t-tk1/git/diff?mode=task")).json.files).toEqual([{ status: "M", path: "app.js" }]);
    const pair = (await call("GET", "/api/ws/t-tk1/git/diff?mode=task&path=app.js")).json;
    expect([pair.original.content, pair.modified.content]).toEqual(["v1\n", "v2\n"]);
    expect((await call("GET", "/api/ws/t-tk1/git/diff?mode=unstaged")).status).toBe(400);
    expect((await call("GET", "/api/ws/t-tk1/git/status")).json.pinned).toBe(true);
    db.run("DELETE FROM tasks WHERE id='tk1'");
    db.run("DELETE FROM projects WHERE id='gp'");
  });
  it("IDE my workspace: separate clone, the only writable kind, real write through the server", async () => {
    const prev = process.env.SF_DATA_DIR;
    process.env.SF_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sf-data-"));
    const repo = mkdtempSync(path.join(tmpdir(), "sf-mine-"));
    const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).toString().trim();
    g(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "app.js"), "v1\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "base");
    g(repo, "remote", "add", "origin", "https://github.com/me/mine-demo.git");
    db.insert("projects", { id: "mp", name: "demo", kind: "github", repo: "me/mine-demo", root_path: repo, default_branch: "main", created_at: 1 });
    try {
      let ws = (await call("GET", "/api/ws")).json.find((w: { id: string }) => w.id === "m-mp");
      expect(ws).toMatchObject({ kind: "mine", exists: false, read_only: true });
      expect((await call("PUT", "/api/ws/m-mp/file?path=app.js", { content: "x", base_sha: null })).status).toBe(403);
      expect((await call("POST", "/api/ws/p-mp/create")).status).toBe(400);
      ws = (await call("POST", "/api/ws/m-mp/create")).json;
      expect(ws).toMatchObject({ kind: "mine", exists: true, read_only: false });
      expect((await call("POST", "/api/ws/m-mp/create")).status).toBe(200); // idempotent
      const mine = path.join(process.env.SF_DATA_DIR, "ide", "mp");
      expect(realpathSync(ws.root)).toBe(realpathSync(mine));
      expect(g(mine, "config", "--get", "remote.origin.url")).toBe("https://github.com/me/mine-demo.git");
      const f = (await call("GET", "/api/ws/m-mp/file?path=app.js")).json;
      const put = await call("PUT", "/api/ws/m-mp/file?path=app.js", { content: "v2\n", base_sha: f.sha256 });
      expect(put.status).toBe(200);
      expect(readFileSync(path.join(mine, "app.js"), "utf8")).toBe("v2\n");
      expect((await call("PUT", "/api/ws/m-mp/file?path=app.js", { content: "v3\n", base_sha: f.sha256 })).status).toBe(409);
      expect((await call("POST", "/api/ws/m-mp/fs", { op: "mkdir", path: "src" })).status).toBe(200);
      expect((await call("PUT", "/api/ws/m-mp/file?path=src/new.ts", { content: "export {};\n", base_sha: null })).status).toBe(200);
      expect((await call("GET", "/api/ws/m-mp/git/status")).json.changes.map((c: { path: string }) => c.path).sort()).toEqual(["app.js", "src/new.ts"]);
      // the mirror is untouched and still read-only
      expect(readFileSync(path.join(repo, "app.js"), "utf8").replace(/\r\n/g, "\n")).toBe("v1\n");
      expect((await call("PUT", "/api/ws/p-mp/file?path=app.js", { content: "x", base_sha: null })).status).toBe(403);
      expect((await call("POST", "/api/ws/p-mp/fs", { op: "delete", path: "app.js" })).status).toBe(403);
      // git writes (M2.3): only in my workspace, push to a local bare remote, never main
      const bare = mkdtempSync(path.join(tmpdir(), "sf-bare-"));
      g(bare, "init", "-q", "--bare", "-b", "main");
      g(mine, "remote", "set-url", "origin", bare);
      g(mine, "config", "user.name", "t");
      g(mine, "config", "user.email", "t@t");
      expect((await call("POST", "/api/ws/p-mp/git/stage", { all: true })).status).toBe(403);
      expect((await call("POST", "/api/ws/m-mp/git/constructor", {})).status).toBe(404);
      expect((await call("POST", "/api/ws/m-mp/git/checkout", { name: "main" })).status).toBe(409); // dirty
      expect((await call("POST", "/api/ws/m-mp/git/branch", { name: "feat/ide", checkout: true })).status).toBe(409);
      expect((await call("POST", "/api/ws/m-mp/git/stage", { paths: ["app.js", "src/new.ts"] })).status).toBe(200);
      expect((await call("POST", "/api/ws/m-mp/git/unstage", { paths: ["src/new.ts"] })).status).toBe(200);
      expect((await call("POST", "/api/ws/m-mp/git/stage", { all: true })).status).toBe(200);
      expect((await call("POST", "/api/ws/m-mp/git/push", {})).status).toBe(403); // on main
      const br = await call("POST", "/api/ws/m-mp/git/branch", { name: "feat/ide", checkout: true });
      expect(br.status).toBe(409); // still dirty (staged)
      expect((await call("POST", "/api/ws/m-mp/git/commit", { message: "wip" })).status).toBe(200);
      expect((await call("POST", "/api/ws/m-mp/git/push", { branch: "main" })).status).toBe(403);
      expect((await call("POST", "/api/ws/m-mp/git/branch", { name: "feat/ide", checkout: true })).json.current).toBe("feat/ide");
      expect((await call("POST", "/api/ws/m-mp/git/push", {})).json).toEqual({ pushed: "feat/ide", remote: "origin" });
      expect(g(bare, "rev-parse", "refs/heads/feat/ide")).toBe(g(mine, "rev-parse", "HEAD"));
      expect(g(bare, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/feat/ide");
      expect((await call("GET", "/api/ws/m-mp/git/branches")).json.local.map((b: { name: string }) => b.name).sort()).toEqual(["feat/ide", "main"]);
    } finally {
      if (prev === undefined) delete process.env.SF_DATA_DIR;
      else process.env.SF_DATA_DIR = prev;
      db.run("DELETE FROM projects WHERE id='mp'");
    }
  });
  it("agent listener rejects unknown runs", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.agentPort}/mcp/nope`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });
});
