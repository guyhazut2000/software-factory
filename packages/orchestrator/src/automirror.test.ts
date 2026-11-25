import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "./db.js";
import { TaskMirror } from "./taskmirror.js";
import { AutomationMirror, createAutomation, fromYaml, toYaml, updateAutomation } from "./automirror.js";

const log = (dir: string) => execFileSync("git", ["log", "--format=%s"], { cwd: dir }).toString().trim().split("\n");
const setup = () => {
  const db = new Db(":memory:");
  db.insert("projects", { id: "p1", name: "Personal", kind: "none", created_at: 1 });
  const dir = mkdtempSync(path.join(os.tmpdir(), "sfauto-"));
  const tasks = new TaskMirror(db, dir, 10_000);
  return { db, dir, m: new AutomationMirror(db, tasks), tasks };
};

describe("automation yaml", () => {
  it("round-trips definitions", () => {
    const def = { id: "a1", project_id: null, name: "Hello world", description: "say hi: now", kind: "command" as const, command: "echo", args: ["hello", "x:y"], cwd: null, runner: "sbx" as const, env_refs: ["API_KEY"], timeout_sec: 60, trigger: "manual" as const, schedule: null, outputs_dir: "out", enabled: true };
    const y = toYaml(def);
    expect(fromYaml(y)).toMatchObject(def);
    expect(fromYaml("name: backup\nkind: agent\ncommand: do it\nargs: []\n")!.kind).toBe("agent");
    expect(fromYaml("# comment only\n")).toBeNull();
  });

  it("writes through, commits, renames, and re-imports changed files", () => {
    const { db, dir, m, tasks } = setup();
    const row = createAutomation(db, m, { name: "Hello", project_id: "p1", command: "echo", args: ["hi"], runner: "host" });
    expect(row).toMatchObject({ name: "Hello", runner: "host", kind: "command", enabled: true, project_id: "p1" });
    const rel = "automations/hello.yaml";
    expect(readFileSync(path.join(dir, rel), "utf8")).toContain("name: Hello");
    expect(tasks.flush()).toBe(true);
    expect(log(dir)[0]).toBe(`automation ${row.id}: create`);
    expect(execFileSync("git", ["remote"], { cwd: dir }).toString().trim()).toBe("");
    updateAutomation(db, m, row.id, { name: "Hello there", description: "updated" });
    tasks.flush();
    expect(readFileSync(path.join(dir, "automations/hello-there.yaml"), "utf8")).toContain("updated");
    expect(log(dir)[0]).toBe(`automation ${row.id}: update`);
    expect(m.importAll().imported).toBe(0);
    writeFileSync(path.join(dir, "automations/hello-there.yaml"), toYaml({ id: row.id, name: "Hello there", description: "from editor", command: "ls", args: [], cwd: null, env_refs: [], timeout_sec: 300, trigger: "manual", schedule: null, outputs_dir: null, enabled: false, kind: "command", runner: "sbx", project_id: "p1" }));
    writeFileSync(path.join(dir, "automations/new-job.yaml"), "id: n1\nname: New job\nkind: command\ncommand: true\nrunner: sbx\n");
    expect(m.importAll().imported).toBe(2);
    expect(db.get("SELECT description, enabled, runner FROM automations WHERE id=?", row.id)).toMatchObject({ description: "from editor", enabled: 0, runner: "sbx" });
    expect(db.get("SELECT * FROM automations WHERE id='n1'")).toMatchObject({ name: "New job", command: "true", kind: "command" });
    expect(m.importAll().imported).toBe(0);
    expect(() => createAutomation(db, m, { name: "Hello there" })).toThrow(/already exists/);
  });
});
