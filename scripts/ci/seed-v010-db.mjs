// CI helper: write a database exactly as v0.1.0 left it, so `pnpm start` must migrate real old data.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const dir = process.argv[2];
if (!dir) throw new Error("usage: seed-v010-db.mjs <data-dir>");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "factory.db");
rmSync(file, { force: true });
const db = new DatabaseSync(file);
db.exec(`
CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL UNIQUE, default_branch TEXT NOT NULL DEFAULT 'main', instructions TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, issue_number INTEGER, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'dev', status TEXT NOT NULL DEFAULT 'queued', assignee_id TEXT, author_id TEXT, branch TEXT, pr_number INTEGER, pr_url TEXT, summary TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', restart_count INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO projects VALUES ('p1','demo','octo/demo','main','',1);
INSERT INTO tasks (id,project_id,issue_number,title,status,created_at,updated_at) VALUES ('t1','p1',7,'Seeded v0.1 task','done',1,1);
INSERT INTO settings VALUES ('mode','"quiet"');
`);
db.close();
console.log("seeded", file);
