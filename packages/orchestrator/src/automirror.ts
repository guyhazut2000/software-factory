import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db, Row } from "./db.js";
import { TaskMirror, hashText } from "./taskmirror.js";
import { now, slug, uid } from "./util.js";

export const KINDS = ["command", "agent"] as const;
export const RUNNERS = ["sbx", "host"] as const;
export const TRIGGERS = ["manual", "schedule", "file_change", "git_push"] as const;

export type AutoKind = (typeof KINDS)[number];
export type AutoRunner = (typeof RUNNERS)[number];
export type AutoTrigger = (typeof TRIGGERS)[number];

export interface AutomationDef {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  kind: AutoKind;
  command: string;
  args: string[];
  cwd: string | null;
  runner: AutoRunner;
  env_refs: string[];
  timeout_sec: number;
  trigger: AutoTrigger;
  schedule: string | null;
  outputs_dir: string | null;
  enabled: boolean;
}

const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const s = String(v);
  if (s === "" || /[:#{}[\],&*?|<>=!%@`'"]/.test(s) || /^\s|\s$/.test(s) || /^(true|false|null|yes|no|on|off)$/i.test(s)) return JSON.stringify(s);
  return s;
}

function yamlList(items: string[]): string {
  if (!items.length) return "[]";
  return items.map((x) => `\n  - ${yamlScalar(x)}`).join("");
}

export function toYaml(a: AutomationDef): string {
  const lines = [
    `id: ${yamlScalar(a.id)}`,
    `project_id: ${yamlScalar(a.project_id)}`,
    `name: ${yamlScalar(a.name)}`,
    `description: ${yamlScalar(a.description)}`,
    `kind: ${yamlScalar(a.kind)}`,
    `command: ${yamlScalar(a.command)}`,
    `args: ${yamlList(a.args)}`,
    `cwd: ${yamlScalar(a.cwd)}`,
    `runner: ${yamlScalar(a.runner)}`,
    `env_refs: ${yamlList(a.env_refs)}`,
    `timeout_sec: ${yamlScalar(a.timeout_sec)}`,
    `trigger: ${yamlScalar(a.trigger)}`,
    `schedule: ${yamlScalar(a.schedule)}`,
    `outputs_dir: ${yamlScalar(a.outputs_dir)}`,
    `enabled: ${yamlScalar(a.enabled)}`,
  ];
  return lines.join("\n") + "\n";
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "null" || s === "~" || s === "") return null;
  if (s === "true" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "no" || s === "off") return false;
  if (s === "[]") return [];
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return s.startsWith('"') ? (JSON.parse(s) as string) : s.slice(1, -1);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** Small YAML subset for automation definitions (scalars + string lists). */
export function fromYaml(text: string): Partial<AutomationDef> | null {
  const fm: Record<string, unknown> = {};
  let listKey: string | null = null;
  let list: string[] = [];
  const flush = () => {
    if (listKey) fm[listKey] = list;
    listKey = null;
    list = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      list.push(String(parseScalar(item[1]!) ?? ""));
      continue;
    }
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    flush();
    const key = m[1]!;
    const rest = m[2]!;
    if (rest === "" || rest === "[]") {
      if (rest === "[]") fm[key] = [];
      else {
        listKey = key;
        list = [];
      }
    } else fm[key] = parseScalar(rest);
  }
  flush();
  if (typeof fm.name !== "string" && typeof fm.id !== "string") return null;
  const one = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const str = (v: unknown) => (v == null ? null : String(v));
  return {
    id: typeof fm.id === "string" && fm.id ? fm.id : undefined,
    project_id: str(fm.project_id),
    name: fm.name == null ? undefined : String(fm.name),
    description: fm.description == null ? "" : String(fm.description),
    kind: one(fm.kind, KINDS, "command"),
    command: fm.command == null ? "" : String(fm.command),
    args: asArr(fm.args),
    cwd: str(fm.cwd),
    runner: one(fm.runner, RUNNERS, "sbx"),
    env_refs: asArr(fm.env_refs),
    timeout_sec: Math.max(1, Math.min(86_400, Math.floor(num(fm.timeout_sec, 300)))),
    trigger: one(fm.trigger, TRIGGERS, "manual"),
    schedule: str(fm.schedule),
    outputs_dir: str(fm.outputs_dir),
    enabled: fm.enabled === undefined ? true : Boolean(fm.enabled),
  };
}

export function parseJsonArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const j = JSON.parse(v);
      return Array.isArray(j) ? j.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function fromRow(r: Row): AutomationDef {
  return {
    id: r.id,
    project_id: r.project_id ?? null,
    name: r.name,
    description: r.description ?? "",
    kind: r.kind,
    command: r.command ?? "",
    args: parseJsonArr(r.args),
    cwd: r.cwd ?? null,
    runner: r.runner,
    env_refs: parseJsonArr(r.env_refs),
    timeout_sec: r.timeout_sec ?? 300,
    trigger: r.trigger ?? "manual",
    schedule: r.schedule ?? null,
    outputs_dir: r.outputs_dir ?? null,
    enabled: !!r.enabled,
  };
}

export function publicAutomation(r: Row): AutomationDef & { yaml_path: string | null; created_at: number; updated_at: number } {
  return { ...fromRow(r), yaml_path: r.yaml_path ?? null, created_at: r.created_at, updated_at: r.updated_at };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) throw new Error("name required");
  if (n.length > 80) throw new Error("name is too long");
  if (!/[a-z0-9]/i.test(n)) throw new Error("name must contain letters or digits");
  return n;
}

export function validateEnvRefs(refs: unknown): string[] {
  const arr = asArr(refs);
  for (const n of arr) if (!ENV_NAME.test(n)) throw new Error(`Invalid env_refs name: ${n}`);
  return arr;
}

export function relPathFor(name: string): string {
  return path.posix.join("automations", `${slug(name)}.yaml`);
}

function toRowFields(a: AutomationDef): Row {
  return {
    project_id: a.project_id,
    name: a.name,
    description: a.description,
    kind: a.kind,
    command: a.command,
    args: JSON.stringify(a.args),
    cwd: a.cwd,
    runner: a.runner,
    env_refs: JSON.stringify(a.env_refs),
    timeout_sec: a.timeout_sec,
    trigger: a.trigger,
    schedule: a.schedule,
    outputs_dir: a.outputs_dir,
    enabled: a.enabled ? 1 : 0,
    updated_at: now(),
  };
}

export function parseBody(b: Record<string, unknown>, existing?: Row): AutomationDef {
  if (b.kind !== undefined && !KINDS.includes(b.kind as AutoKind)) throw new Error("kind must be command or agent");
  if (b.runner !== undefined && !RUNNERS.includes(b.runner as AutoRunner)) throw new Error("runner must be sbx or host");
  if (b.trigger !== undefined && !TRIGGERS.includes(b.trigger as AutoTrigger)) throw new Error("trigger must be manual, schedule, file_change or git_push");
  const name = validateName(b.name ?? existing?.name);
  const kind = KINDS.includes(b.kind as AutoKind) ? (b.kind as AutoKind) : existing ? fromRow(existing).kind : "command";
  const runner = RUNNERS.includes(b.runner as AutoRunner) ? (b.runner as AutoRunner) : existing ? fromRow(existing).runner : "sbx";
  const trigger = TRIGGERS.includes(b.trigger as AutoTrigger) ? (b.trigger as AutoTrigger) : existing ? fromRow(existing).trigger : "manual";
  const timeout = b.timeout_sec !== undefined ? Math.max(1, Math.min(86_400, Math.floor(Number(b.timeout_sec)))) : existing?.timeout_sec ?? 300;
  if (!Number.isFinite(timeout)) throw new Error("timeout_sec must be a number");
  const command = b.command !== undefined ? String(b.command ?? "") : (existing?.command ?? "");
  const args = b.args !== undefined ? asArr(b.args) : existing ? parseJsonArr(existing.args) : [];
  const env_refs = validateEnvRefs(b.env_refs !== undefined ? b.env_refs : existing ? parseJsonArr(existing.env_refs) : []);
  const project_id = b.project_id !== undefined ? (b.project_id ? String(b.project_id) : null) : (existing?.project_id ?? null);
  const enabled = b.enabled !== undefined ? Boolean(b.enabled) : existing ? !!existing.enabled : true;
  return {
    id: existing?.id ?? uid(),
    project_id,
    name,
    description: b.description !== undefined ? String(b.description ?? "") : (existing?.description ?? ""),
    kind,
    command,
    args,
    cwd: b.cwd !== undefined ? (b.cwd ? String(b.cwd) : null) : (existing?.cwd ?? null),
    runner,
    env_refs,
    timeout_sec: timeout,
    trigger,
    schedule: b.schedule !== undefined ? (b.schedule ? String(b.schedule) : null) : (existing?.schedule ?? null),
    outputs_dir: b.outputs_dir !== undefined ? (b.outputs_dir ? String(b.outputs_dir) : null) : (existing?.outputs_dir ?? null),
    enabled,
  };
}

export class AutomationMirror {
  constructor(
    private db: Db,
    private tasks: TaskMirror,
  ) {}

  /** Write-through: SQLite row -> YAML; commit is debounced via the workspace repo. */
  write(id: string, change = "update"): void {
    const r = this.db.get("SELECT * FROM automations WHERE id=?", id);
    if (!r) return;
    this.tasks.ensure();
    const def = fromRow(r);
    const rel = relPathFor(def.name);
    if (r.yaml_path && r.yaml_path !== rel) rmSync(path.join(this.tasks.dir, r.yaml_path), { force: true });
    const yaml = toYaml(def);
    mkdirSync(path.dirname(path.join(this.tasks.dir, rel)), { recursive: true });
    writeFileSync(path.join(this.tasks.dir, rel), yaml);
    this.db.run("UPDATE automations SET yaml_path=?, yaml_hash=? WHERE id=?", rel, hashText(yaml), id);
    this.tasks.queueCommit(`automation ${id}: ${change}`);
  }

  remove(id: string): void {
    const r = this.db.get("SELECT yaml_path FROM automations WHERE id=?", id);
    if (!r?.yaml_path) return;
    rmSync(path.join(this.tasks.dir, r.yaml_path), { force: true });
    this.tasks.queueCommit(`automation ${id}: delete`);
  }

  /** On start: re-import YAML files whose hash differs from SQLite (edited by hand or git-pulled). */
  importAll(): { imported: number } {
    this.tasks.ensure();
    let imported = 0;
    const root = path.join(this.tasks.dir, "automations");
    if (!existsSync(root)) return { imported };
    const seen = new Set<string>();
    for (const f of readdirSync(root)) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      const rel = path.posix.join("automations", f);
      const text = readFileSync(path.join(this.tasks.dir, rel), "utf8");
      const h = hashText(text);
      const p = fromYaml(text);
      if (!p || !(p.id || p.name)) continue;
      const ex = p.id ? this.db.get("SELECT id, yaml_hash FROM automations WHERE id=?", p.id) : this.db.get("SELECT id, yaml_hash FROM automations WHERE name=?", p.name);
      if (ex && ex.yaml_hash === h) {
        seen.add(ex.id);
        continue;
      }
      const id = ex?.id ?? p.id ?? uid();
      if (seen.has(id)) continue;
      const name = validateName(p.name ?? ex?.id ?? id);
      if (this.db.get("SELECT id FROM automations WHERE name=? AND id<>?", name, id)) continue;
      const project_id = p.project_id && this.db.get("SELECT id FROM projects WHERE id=?", p.project_id) ? p.project_id : (ex ? this.db.get("SELECT project_id FROM automations WHERE id=?", id)?.project_id ?? null : null);
      const def: AutomationDef = {
        id,
        project_id,
        name,
        description: p.description ?? "",
        kind: p.kind ?? "command",
        command: p.command ?? "",
        args: p.args ?? [],
        cwd: p.cwd ?? null,
        runner: p.runner ?? "sbx",
        env_refs: p.env_refs ?? [],
        timeout_sec: p.timeout_sec ?? 300,
        trigger: p.trigger ?? "manual",
        schedule: p.schedule ?? null,
        outputs_dir: p.outputs_dir ?? null,
        enabled: p.enabled !== false,
      };
      const fields = { ...toRowFields(def), yaml_path: rel, yaml_hash: h };
      if (ex) this.db.update("automations", id, fields);
      else this.db.insert("automations", { id, created_at: now(), ...fields });
      seen.add(id);
      imported++;
    }
    return { imported };
  }
}

export function createAutomation(db: Db, mirror: AutomationMirror | null, b: Record<string, unknown>): Row {
  const def = parseBody(b);
  if (def.project_id && !db.get("SELECT id FROM projects WHERE id=?", def.project_id)) throw new Error("project not found");
  if (db.get("SELECT id FROM automations WHERE name=?", def.name)) throw new Error("An automation with that name already exists");
  if (db.get("SELECT id FROM automations WHERE yaml_path=?", relPathFor(def.name))) throw new Error("An automation with that name already exists");
  db.insert("automations", { id: def.id, created_at: now(), ...toRowFields(def) });
  mirror?.write(def.id, "create");
  return publicAutomation(db.get("SELECT * FROM automations WHERE id=?", def.id)!);
}

export function updateAutomation(db: Db, mirror: AutomationMirror | null, id: string, b: Record<string, unknown>): Row {
  const ex = db.get("SELECT * FROM automations WHERE id=?", id);
  if (!ex) throw Object.assign(new Error("automation not found"), { status: 404 });
  const def = parseBody(b, ex);
  if (def.project_id && !db.get("SELECT id FROM projects WHERE id=?", def.project_id)) throw new Error("project not found");
  if (db.get("SELECT id FROM automations WHERE name=? AND id<>?", def.name, id)) throw new Error("An automation with that name already exists");
  if (db.get("SELECT id FROM automations WHERE yaml_path=? AND id<>?", relPathFor(def.name), id)) throw new Error("An automation with that name already exists");
  db.update("automations", id, toRowFields(def));
  mirror?.write(id, "update");
  return publicAutomation(db.get("SELECT * FROM automations WHERE id=?", id)!);
}

export function deleteAutomation(db: Db, mirror: AutomationMirror | null, id: string): void {
  const ex = db.get("SELECT id FROM automations WHERE id=?", id);
  if (!ex) throw Object.assign(new Error("automation not found"), { status: 404 });
  mirror?.remove(id);
  db.run("DELETE FROM automations WHERE id=?", id);
}
