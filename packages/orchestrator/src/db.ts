import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

// vite strips the `node:` prefix on static imports of node:sqlite, so load it at runtime.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Baseline schema (v1) = the schema shipped in v0.1.0. Never edit; add a migration instead. */
const BASELINE = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL UNIQUE, default_branch TEXT NOT NULL DEFAULT 'main',
  instructions TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL DEFAULT 'medium',
  context TEXT NOT NULL DEFAULT '{}', permissions TEXT NOT NULL DEFAULT '["open_pr"]',
  token_budget INTEGER, max_runtime_sec INTEGER NOT NULL DEFAULT 1800, cpu INTEGER NOT NULL DEFAULT 2, ram_mb INTEGER NOT NULL DEFAULT 4096,
  skills TEXT NOT NULL DEFAULT '[]', mcp TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'off', current_task_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, issue_number INTEGER, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'dev', status TEXT NOT NULL DEFAULT 'queued', assignee_id TEXT, author_id TEXT,
  branch TEXT, pr_number INTEGER, pr_url TEXT, summary TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  restart_count INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT NOT NULL, kind TEXT NOT NULL, runner TEXT, started_at INTEGER NOT NULL,
  ended_at INTEGER, exit_reason TEXT, last_heartbeat_at INTEGER, tokens INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'chat', task_id TEXT, project_id TEXT, from_id TEXT, to_id TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT, project_id TEXT, body TEXT NOT NULL, answer TEXT, asked_at INTEGER NOT NULL, answered_at INTEGER);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
`;

export type Migration = { version: number; name: string; up: (db: Db) => void };

/** Ordered schema migrations. Append only; each runs once inside a transaction. */
export const MIGRATIONS: Migration[] = [
  // v1: baseline. Uses IF NOT EXISTS so existing v0.1.0 databases (which have no schema_migrations table) adopt it as-is.
  { version: 1, name: "baseline", up: (db) => db.exec(BASELINE) },
  // v2: project kinds. SQLite cannot drop NOT NULL in place, so rebuild `projects` (repo becomes nullable).
  {
    version: 2,
    name: "project_kinds",
    up: (db) =>
      db.exec(`
CREATE TABLE projects_v2 (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'github' CHECK (kind IN ('github','folder','none')),
  repo TEXT UNIQUE, root_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main',
  instructions TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  CHECK (kind <> 'github' OR repo IS NOT NULL), CHECK (kind <> 'folder' OR root_path IS NOT NULL));
INSERT INTO projects_v2 (id,name,kind,repo,root_path,default_branch,instructions,created_at)
  SELECT id,name,'github',repo,NULL,default_branch,instructions,created_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_v2 RENAME TO projects;`),
  },
];

export class Db {
  private d: DB;
  constructor(file: string, migrations: Migration[] = MIGRATIONS) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.d = new DatabaseSync(file);
    this.d.exec("PRAGMA journal_mode = WAL;");
    this.migrate(migrations);
  }
  exec(sql: string): void {
    this.d.exec(sql);
  }
  /** Current schema version (0 = empty database). */
  version(): number {
    return (this.get("SELECT MAX(version) AS v FROM schema_migrations")?.v as number | null) ?? 0;
  }
  /** Apply pending migrations in order, each atomically. Refuses a database newer than this build. */
  migrate(migrations: Migration[]): void {
    this.d.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const cur = this.version();
    const latest = sorted.at(-1)?.version ?? 0;
    if (cur > latest) throw new Error(`Database schema v${cur} is newer than this app (v${latest}). Update Software Factory.`);
    for (const m of sorted) {
      if (m.version <= cur) continue;
      this.d.exec("BEGIN");
      try {
        m.up(this);
        this.run("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)", m.version, m.name, Date.now());
        this.d.exec("COMMIT");
      } catch (e) {
        this.d.exec("ROLLBACK");
        throw new Error(`Migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
      }
    }
  }
  /** True if `table` has `column` (for idempotent ALTERs). */
  hasColumn(table: string, column: string): boolean {
    return this.all(`PRAGMA table_info(${table})`).some((c) => c.name === column);
  }
  close(): void {
    this.d.close();
  }
  all(sql: string, ...p: unknown[]): Row[] {
    return this.d.prepare(sql).all(...(p as never[])) as Row[];
  }
  get(sql: string, ...p: unknown[]): Row | undefined {
    return this.d.prepare(sql).get(...(p as never[])) as Row | undefined;
  }
  run(sql: string, ...p: unknown[]): void {
    this.d.prepare(sql).run(...(p as never[]));
  }
  /** Partial update by id. */
  update(table: string, id: string, patch: Row): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`, ...keys.map((k) => patch[k] ?? null), id);
  }
  insert(table: string, row: Row): void {
    const keys = Object.keys(row);
    this.run(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => row[k] ?? null));
  }
  getSetting<T>(k: string, def: T): T {
    const r = this.get("SELECT v FROM settings WHERE k=?", k);
    return r ? (JSON.parse(r.v) as T) : def;
  }
  setSetting(k: string, v: unknown): void {
    this.run("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, JSON.stringify(v));
  }
}
