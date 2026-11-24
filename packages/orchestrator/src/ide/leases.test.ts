import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../db.js";
import { Hub } from "../hub.js";
import { Engine } from "../engine.js";
import { ideRoute } from "./routes.js";
import { taskWorktreeDir } from "./workspaces.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).toString().trim();
const BR = "sf/1-login";
let remote: string;
const db = new Db(":memory:");
const engine = new Engine(db, new Hub());
const call = (method: string, p: string, b: Record<string, unknown> = {}) => ideRoute(db, method, new URL(`http://x/api/ws/${p}`), b, engine) as Promise<Record<string, unknown>>;
const status = async (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);

beforeAll(() => {
  const tmp = mkdtempSync(path.join(tmpdir(), "sf-lease-"));
  process.env.SF_DATA_DIR = path.join(tmp, "data");
  remote = path.join(tmp, "remote.git");
  const seed = path.join(tmp, "seed");
  mkdirSync(seed);
  g(tmp, "init", "-q", "--bare", "-b", "main", remote);
  g(seed, "init", "-q", "-b", "main");
  writeFileSync(path.join(seed, "a.txt"), "one\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-qm", "first");
  g(seed, "remote", "add", "origin", remote);
  g(seed, "push", "-q", "origin", "main", `main:${BR}`);
  const mirror = path.join(tmp, "mirror");
  g(tmp, "clone", "-q", remote, mirror);
  // the agent's local worktree (worktree runner)
  const wt = taskWorktreeDir("t1");
  mkdirSync(path.dirname(wt), { recursive: true });
  g(tmp, "clone", "-q", "-b", BR, remote, wt);
  db.insert("projects", { id: "p1", name: "demo", kind: "github", repo: "me/demo", root_path: mirror, default_branch: "main", created_at: 1 });
  db.insert("tasks", { id: "t1", project_id: "p1", source: "github", type: "code", external_ref: "1", title: "Login", status: "working", branch: BR, created_at: 1, updated_at: 1 });
  db.insert("tasks", { id: "r1", project_id: "p1", source: "github", type: "review", external_ref: "1", title: "Review", status: "queued", branch: BR, created_at: 1, updated_at: 1 });
});

describe("edit leases", () => {
  let killed = 0;
  it("an agent workspace is read-only while its run is active", async () => {
    engine.active.set("run1", { runId: "run1", agent: { id: "a1", name: "dev-1" }, task: { id: "t1" }, lastText: "", errTail: [], tokens: 0, startedAt: 0, kill: () => { killed++; setTimeout(() => engine.active.delete("run1"), 20); } } as never);
    const w = await call("GET", "t-t1");
    expect(w).toMatchObject({ read_only: true, lease: { owner: "agent", agent: "dev-1" } });
    expect(await status(call("PUT", "t-t1/file?path=a.txt", { content: "x" }))).toBe(403);
    expect(await status(call("POST", "t-t1/git/commit", { message: "x" }))).toBe(403);
    expect(await status(call("POST", "t-t1/handback"))).toBe(400);
  });
  it("take over soft-stops the run and leases the workspace to Guy", async () => {
    const w = await call("POST", "t-t1/takeover");
    expect(killed).toBe(1);
    expect(engine.active.size).toBe(0);
    expect(w).toMatchObject({ read_only: false, lease: { owner: "guy" } });
    expect(db.get("SELECT status, lease FROM tasks WHERE id='t1'")).toMatchObject({ status: "waiting_for_guy", lease: "guy" });
    db.update("tasks", "t1", { status: "queued" });
    expect(engine.runnableTasks().map((t) => t.id)).not.toContain("t1"); // agents skip leased tasks
    db.update("tasks", "t1", { status: "waiting_for_guy" });
  });
  it("Guy can edit, then hand back pushes his commit and re-queues the task", async () => {
    await call("PUT", "t-t1/file?path=b.txt", { content: "guy\n" });
    await call("POST", "t-t1/handback");
    expect(g(remote, "log", "-1", "--format=%s", BR)).toBe("Guy's edits (IDE take-over)");
    expect(g(remote, "show", `${BR}:b.txt`)).toBe("guy");
    const t = db.get("SELECT * FROM tasks WHERE id='t1'")!;
    expect(t).toMatchObject({ status: "queued", lease: null, note: "Handed back by Guy" });
    expect(t.summary).toContain(`committed on ${BR}`);
    expect(engine.runnableTasks().map((x) => x.id)).toContain("t1");
    expect(await call("GET", "t-t1")).toMatchObject({ read_only: true });
    expect(await status(call("PUT", "t-t1/file?path=b.txt", { content: "y" }))).toBe(403);
  });
  it("rejects leases on review tasks and other workspaces", async () => {
    expect(await status(call("POST", "t-r1/takeover"))).toBe(400);
    expect(await status(call("POST", "p-p1/takeover"))).toBe(400);
  });
});
