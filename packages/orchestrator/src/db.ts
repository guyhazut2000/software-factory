import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

// vite strips the `node:` prefix on static imports of node:sqlite, so load it at runtime.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DDL = `
PRAGMA journal_mode = WAL;
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

export class Db {
  private d: DB;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.d = new DatabaseSync(file);
    this.d.exec(DDL);
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
