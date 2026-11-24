import { describe, it, expect } from "vitest";
import { Db } from "./db.js";
import { Hub } from "./hub.js";
import { Engine } from "./engine.js";
import { backfillRoots } from "./projects.js";
import { repoDirFor } from "./workspace.js";

describe("engine tasks on the unified schema", () => {
  const db = new Db(":memory:");
  const engine = new Engine(db, new Hub());
  const project = { id: "p1", name: "demo", kind: "github", repo: "me/demo", default_branch: "main", instructions: "", created_at: 1 };
  db.insert("projects", project);
  it("creates github code tasks from issues once", async () => {
    const a = await engine.createTaskFromIssue(project, 12, "Add login", "body", ["status:ready"]);
    const b = await engine.createTaskFromIssue(project, 12, "Add login", "body", ["status:ready"]);
    expect(b.id).toBe(a.id);
    expect(db.get("SELECT * FROM tasks WHERE id=?", a.id)).toMatchObject({ source: "github", type: "code", external_ref: "12", issue_number: 12, kind: "dev" });
  });
  it("only schedules code/review tasks on github projects, reviews first", () => {
    db.insert("projects", { id: "f1", name: "data", kind: "folder", root_path: "/tmp", created_at: 1 });
    db.insert("tasks", { id: "m1", source: "local", type: "manual", title: "Call the bank", status: "queued", created_at: 1, updated_at: 1 });
    db.insert("tasks", { id: "c1", source: "local", type: "code", project_id: "f1", title: "folder code", status: "queued", created_at: 1, updated_at: 1 });
    db.insert("tasks", { id: "r1", source: "github", type: "review", project_id: "p1", external_ref: "12", title: "Review", status: "queued", created_at: 9, updated_at: 9 });
    const ids = engine.runnableTasks().map((r) => r.id);
    expect(ids[0]).toBe("r1");
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain("m1");
    expect(ids).not.toContain("c1");
  });
  it("creates, edits and completes local manual tasks; local code tasks are held", () => {
    const m = engine.createLocalTask({ title: " Pay rent ", body: "by the 1st" });
    expect(m).toMatchObject({ source: "local", type: "manual", status: "queued", project_id: null, title: "Pay rent" });
    expect(engine.updateLocalTask(m.id, { title: "Pay rent now", priority: 2, project_id: "f1" })).toMatchObject({ title: "Pay rent now", priority: 2, project_id: "f1" });
    engine.completeTask(m.id);
    expect(db.get("SELECT status FROM tasks WHERE id=?", m.id)?.status).toBe("done");
    engine.completeTask(m.id, false);
    expect(db.get("SELECT status FROM tasks WHERE id=?", m.id)?.status).toBe("queued");
    const c = engine.createLocalTask({ type: "code", title: "Refactor", project_id: "p1" });
    expect(engine.runnableTasks().map((r) => r.id)).not.toContain(c.id);
    expect(() => engine.completeTask(c.id)).toThrow(/manual/);
    expect(() => engine.createLocalTask({ title: "" })).toThrow(/title/);
    expect(() => engine.createLocalTask({ title: "x", type: "script" })).toThrow();
    expect(() => engine.createLocalTask({ title: "x", project_id: "nope" })).toThrow(/project/);
    const gh = db.get("SELECT id FROM tasks WHERE source='github' AND type='code'")!;
    expect(() => engine.updateLocalTask(gh.id, { title: "y" })).toThrow(/local/);
  });
  it("backfills root_path for github projects linked before v2", () => {
    backfillRoots(db);
    expect(db.get("SELECT root_path FROM projects WHERE id='p1'")?.root_path).toBe(repoDirFor("me/demo"));
    expect(db.get("SELECT root_path FROM projects WHERE id='f1'")?.root_path).toBe("/tmp");
  });
});
