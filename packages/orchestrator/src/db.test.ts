import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db, MIGRATIONS, type Migration } from "./db.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sf-db-")), "factory.db");

/** Exact v0.1.0 projects/tasks DDL, as an old install has it (no schema_migrations table). */
const V010 = `
CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL UNIQUE, default_branch TEXT NOT NULL DEFAULT 'main', instructions TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, issue_number INTEGER, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'dev', status TEXT NOT NULL DEFAULT 'queued', assignee_id TEXT, author_id TEXT, branch TEXT, pr_number INTEGER, pr_url TEXT, summary TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', restart_count INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO projects VALUES ('p1','demo','me/demo','main','',1);
INSERT INTO tasks (id,project_id,issue_number,title,status,created_at,updated_at) VALUES ('t1','p1',7,'Fix bug','queued',1,1);
INSERT INTO settings VALUES ('mode','"eco"');
`;

describe("migrations", () => {
  it("fresh database lands on the latest version", () => {
    const db = new Db(":memory:");
    expect(db.version()).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)).toEqual(expect.arrayContaining(["projects", "tasks", "agents", "runs"]));
  });
  it("adopts a v0.1.0 database without losing data", () => {
    const f = tmp();
    const old = new DatabaseSync(f);
    old.exec(V010);
    old.close();
    const db = new Db(f);
    expect(db.version()).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.get("SELECT title FROM tasks WHERE id='t1'")?.title).toBe("Fix bug");
    expect(db.get("SELECT repo FROM projects WHERE id='p1'")?.repo).toBe("me/demo");
    expect(db.getSetting("mode", "full")).toBe("eco");
    db.close();
    // reopening is a no-op
    const again = new Db(f);
    expect(again.all("SELECT * FROM schema_migrations").length).toBe(MIGRATIONS.length);
    again.close();
  });
  it("applies migrations once, in order, and rolls back a failing one", () => {
    const f = tmp();
    const log: number[] = [];
    const ms: Migration[] = [
      ...MIGRATIONS,
      { version: 1001, name: "b", up: (d) => { log.push(1001); d.exec("CREATE TABLE b (x)"); } },
      { version: 1000, name: "a", up: (d) => { log.push(1000); d.exec("CREATE TABLE a (x)"); } },
    ];
    new Db(f, ms).close();
    new Db(f, ms).close();
    expect(log).toEqual([1000, 1001]);
    const bad: Migration[] = [...ms, { version: 1002, name: "bad", up: (d) => { d.exec("CREATE TABLE c (x)"); throw new Error("boom"); } }];
    expect(() => new Db(f, bad)).toThrow(/1002 \(bad\) failed: boom/);
    const db = new Db(f, ms);
    expect(db.version()).toBe(1001);
    expect(db.all("SELECT name FROM sqlite_master WHERE name='c'")).toHaveLength(0);
    db.close();
  });
  it("refuses a database from a newer app", () => {
    const f = tmp();
    new Db(f, [...MIGRATIONS, { version: 999, name: "future", up: () => {} }]).close();
    expect(() => new Db(f)).toThrow(/newer than this app/);
  });
});

describe("v2 project kinds", () => {
  it("existing projects become github projects and keep their repo", () => {
    const f = tmp();
    const old = new DatabaseSync(f);
    old.exec(V010);
    old.close();
    const db = new Db(f);
    expect(db.get("SELECT kind, repo FROM projects WHERE id='p1'")).toMatchObject({ kind: "github", repo: "me/demo" });
    db.close();
  });
  it("enforces kind rules", () => {
    const db = new Db(":memory:");
    db.insert("projects", { id: "n", name: "Personal", kind: "none", created_at: 1 });
    db.insert("projects", { id: "f", name: "Data", kind: "folder", root_path: "/tmp", created_at: 1 });
    expect(() => db.insert("projects", { id: "g", name: "x", kind: "github", created_at: 1 })).toThrow();
    expect(() => db.insert("projects", { id: "h", name: "x", kind: "folder", created_at: 1 })).toThrow();
    expect(() => db.insert("projects", { id: "i", name: "x", kind: "bogus", created_at: 1 })).toThrow();
  });
});

describe("v3 unified tasks", () => {
  it("backfills source/type/external_ref and keeps issue_number and kind readable", () => {
    const f = tmp();
    const old = new DatabaseSync(f);
    old.exec(V010);
    old.exec("INSERT INTO tasks (id,project_id,issue_number,title,kind,status,pr_number,created_at,updated_at) VALUES ('r1','p1',7,'Review PR #3','review','queued',3,2,2)");
    old.close();
    const db = new Db(f);
    expect(db.get("SELECT * FROM tasks WHERE id='t1'")).toMatchObject({ source: "github", type: "code", external_ref: "7", issue_number: 7, kind: "dev", title: "Fix bug", project_id: "p1" });
    expect(db.get("SELECT * FROM tasks WHERE id='r1'")).toMatchObject({ type: "review", kind: "review", issue_number: 7, pr_number: 3 });
    expect(db.get("SELECT id FROM tasks WHERE project_id='p1' AND issue_number=7 AND kind='dev'")?.id).toBe("t1");
    db.close();
  });
  it("supports loose local tasks and planning fields", () => {
    const db = new Db(":memory:");
    db.insert("tasks", { id: "l1", source: "local", type: "manual", title: "Pay bills", priority: 1, due_at: 5, md_path: "tasks/_loose/l1-pay-bills.md", created_at: 1, updated_at: 1 });
    expect(db.get("SELECT * FROM tasks WHERE id='l1'")).toMatchObject({ project_id: null, issue_number: null, kind: "manual", priority: 1 });
    expect(() => db.insert("tasks", { id: "g1", source: "github", title: "no ref", project_id: "p", created_at: 1, updated_at: 1 })).toThrow();
    expect(() => db.insert("tasks", { id: "x1", source: "local", type: "bogus", title: "x", created_at: 1, updated_at: 1 })).toThrow();
  });
});
