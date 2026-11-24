import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "./db.js";
import { TaskMirror, fromMarkdown, toMarkdown } from "./taskmirror.js";

const log = (dir: string) => execFileSync("git", ["log", "--format=%s"], { cwd: dir }).toString().trim().split("\n");
const setup = () => {
  const db = new Db(":memory:");
  db.insert("projects", { id: "p1", name: "Finance Data", kind: "none", created_at: 1 });
  db.insert("tasks", { id: "l1", project_id: "p1", source: "local", type: "manual", title: "Pay bills", body: "Electric + water", priority: 2, labels: '["home"]', created_at: 1, updated_at: 1 });
  const dir = mkdtempSync(path.join(os.tmpdir(), "sfws-"));
  return { db, dir, m: new TaskMirror(db, dir, 10_000) };
};

describe("task mirror", () => {
  it("round-trips front matter", () => {
    const md = toMarkdown({ id: "a", title: 'Say "hi": now', status: "done", type: "script", priority: null, due_at: 5, labels: '["x"]', assignee_id: null, body: "line1\nline2" });
    expect(fromMarkdown(md)).toMatchObject({ id: "a", title: 'Say "hi": now', status: "done", type: "script", due_at: 5, labels: '["x"]', body: "line1\nline2" });
    expect(fromMarkdown("no front matter")).toBeNull();
  });

  it("writes through, debounces commits, moves on rename, ignores github tasks", () => {
    const { db, dir, m } = setup();
    m.write("l1", "create");
    m.write("l1", "status");
    const rel = "tasks/finance-data/l1-pay-bills.md";
    expect(db.get("SELECT md_path FROM tasks WHERE id='l1'")!.md_path).toBe(rel);
    expect(readFileSync(path.join(dir, rel), "utf8")).toContain('title: "Pay bills"');
    expect(m.flush()).toBe(true);
    expect(log(dir)[0]).toBe("tasks: 2 changes");
    expect(execFileSync("git", ["remote"], { cwd: dir }).toString().trim()).toBe("");
    db.update("tasks", "l1", { title: "Pay all bills" });
    m.write("l1", "title");
    m.flush();
    expect(existsSync(path.join(dir, rel))).toBe(false);
    expect(existsSync(path.join(dir, "tasks/finance-data/l1-pay-all-bills.md"))).toBe(true);
    expect(log(dir)[0]).toBe("task l1: title");
    db.insert("tasks", { id: "g1", project_id: "p1", source: "github", external_ref: "3", title: "gh", created_at: 1, updated_at: 1 });
    m.write("g1");
    expect(m.flush()).toBe(false);
  });

  it("re-imports only changed files on start, and new files", () => {
    const { db, dir, m } = setup();
    m.write("l1", "create");
    m.flush();
    expect(m.importAll().imported).toBe(0);
    const f = path.join(dir, "tasks/finance-data/l1-pay-bills.md");
    writeFileSync(f, readFileSync(f, "utf8").replace('"queued"', '"done"').replace("Electric", "Gas"));
    mkdirSync(path.join(dir, "tasks/_loose"));
    writeFileSync(path.join(dir, "tasks/_loose/n1-new.md"), '---\nid: "n1"\ntitle: "From editor"\n---\nhello\n');
    expect(m.importAll().imported).toBe(2);
    expect(db.get("SELECT status, body FROM tasks WHERE id='l1'")).toMatchObject({ status: "done", body: "Gas + water" });
    expect(db.get("SELECT * FROM tasks WHERE id='n1'")).toMatchObject({ source: "local", type: "manual", project_id: null, title: "From editor", body: "hello" });
    expect(m.importAll().imported).toBe(0);
  });
});
