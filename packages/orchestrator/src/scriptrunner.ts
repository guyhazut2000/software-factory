import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Db, Row } from "./db.js";
import type { Hub } from "./hub.js";
import { fromRow, type AutomationDef } from "./automirror.js";
import { now, run as runCmd, stream as streamCmd, uid, which, type ExecResult, type Streaming } from "./util.js";
import { sandboxNameForRun, sbxCreateMountArgs } from "./workspace.js";

export interface ExecDeps {
  run: (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<ExecResult>;
  stream: (argv: string[], opts: { cwd?: string; env?: Record<string, string>; onLine: (line: string, isErr: boolean) => void }) => Streaming;
}

const defaultDeps: ExecDeps = { run: runCmd, stream: streamCmd };

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function resolveEnv(refs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of refs) {
    const v = process.env[name];
    if (v === undefined) missing.push(name);
    else env[name] = v;
  }
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
  return env;
}

/** Resolve cwd against the project folder; must stay inside it when a root exists. */
export function resolveCwd(projectRoot: string | null, cwd: string | null): string {
  if (!cwd) {
    if (!projectRoot) throw new Error("cwd required when the project has no folder");
    return mustDir(projectRoot);
  }
  const abs = path.isAbsolute(cwd) ? cwd : path.join(projectRoot ?? process.cwd(), cwd);
  const resolved = mustDir(abs);
  if (projectRoot) {
    const root = mustDir(projectRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("cwd must be inside the project folder");
  }
  return resolved;
}

function mustDir(p: string): string {
  let root: string;
  try {
    root = realpathSync(p);
  } catch {
    throw new Error(`Folder not found: ${p}`);
  }
  if (!statSync(root).isDirectory()) throw new Error(`Not a folder: ${p}`);
  return root;
}

function hostArgv(def: AutomationDef): string[] {
  if (def.args.length) return [def.command, ...def.args];
  if (process.platform === "win32") return ["cmd", "/c", def.command];
  return ["sh", "-c", def.command];
}

export class ScriptRunner {
  constructor(
    private db: Db,
    private hub: Hub,
    private settings: () => { allow_worktree: boolean },
  ) {}

  /** Validate and start a manual run. Returns the run row immediately; logs stream over the hub. */
  start(automationId: string, deps: Partial<ExecDeps> = {}): Row {
    const row = this.db.get("SELECT * FROM automations WHERE id=?", automationId);
    if (!row) throw Object.assign(new Error("automation not found"), { status: 404 });
    const def = fromRow(row);
    if (!def.enabled) throw new Error("Automation is disabled");
    if (def.kind !== "command") throw new Error("Agent automations cannot be run yet");
    if (!def.command.trim()) throw new Error("command required");
    if (def.runner === "host" && !this.settings().allow_worktree) {
      throw new Error("Host runner is disabled. Enable the unsafe worktree fallback in Settings, or use the sbx runner.");
    }
    if (def.runner === "sbx" && !deps.run && !deps.stream && !which("sbx")) throw new Error("sbx not found on PATH");
    const project = def.project_id ? this.db.get("SELECT * FROM projects WHERE id=?", def.project_id) : undefined;
    const root = typeof project?.root_path === "string" && project.root_path ? resolveCwd(project.root_path, null) : null;
    const cwd = resolveCwd(root, def.cwd);
    const env = resolveEnv(def.env_refs);
    const id = uid();
    const started = now();
    this.db.insert("runs", { id, task_id: null, agent_id: null, automation_id: def.id, kind: "script", runner: def.runner, started_at: started, last_heartbeat_at: started, tokens: 0 });
    this.log(id, "system", `start ${def.name} (${def.runner})`);
    void this.execute(id, def, cwd, env, root, { ...defaultDeps, ...deps }).catch((e) => this.finish(id, 1, "error", String(e)));
    return this.db.get("SELECT * FROM runs WHERE id=?", id)!;
  }

  private async execute(runId: string, def: AutomationDef, cwd: string, env: Record<string, string>, root: string | null, deps: ExecDeps): Promise<void> {
    let timedOut = false;
    const timeoutMs = def.timeout_sec * 1000;
    const onLine = (line: string, isErr: boolean) => this.log(runId, isErr ? "stderr" : "stdout", line);
    let streaming: Streaming | undefined;
    let sandbox: string | null = null;
    try {
      if (def.runner === "sbx") {
        sandbox = sandboxNameForRun(runId);
        const created = await deps.run("sbx", sbxCreateMountArgs({ name: sandbox, dir: root ?? cwd }), { timeoutMs: 600_000 });
        if (created.code !== 0) throw new Error(`sbx create failed: ${(created.stderr || created.stdout).trim().slice(0, 400)}`);
        const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
        const inner = def.args.length
          ? `cd ${q(cwd)} && exec ${[def.command, ...def.args].map(q).join(" ")}`
          : `cd ${q(cwd)} && ${def.command}`;
        streaming = deps.stream(["sbx", "exec", ...envArgs, sandbox, "sh", "-c", inner], { env, onLine });
      } else {
        streaming = deps.stream(hostArgv(def), { cwd, env, onLine });
      }
      if (!streaming) throw new Error("failed to start command");
      const proc = streaming;
      const code = await new Promise<number>((resolve) => {
        const t = setTimeout(() => {
          timedOut = true;
          proc.kill();
          resolve(124);
        }, timeoutMs);
        proc.done.then((c) => {
          clearTimeout(t);
          if (!timedOut) resolve(c);
        });
      });
      this.finish(runId, code, timedOut ? "timeout" : code === 0 ? "ok" : "error");
    } catch (e) {
      this.finish(runId, 1, "error", (e as Error).message);
    } finally {
      if (sandbox) {
        await deps.run("sbx", ["stop", sandbox]).catch(() => {});
        await deps.run("sbx", ["rm", "--force", sandbox]).catch(() => {});
      }
    }
  }

  private finish(runId: string, code: number, reason: string, err?: string): void {
    const r = this.db.get("SELECT ended_at FROM runs WHERE id=?", runId);
    if (!r || r.ended_at) return;
    if (err) this.log(runId, "stderr", err);
    this.log(runId, "system", `exit ${code} (${reason})`);
    this.db.run("UPDATE runs SET ended_at=?, exit_reason=?, last_heartbeat_at=? WHERE id=?", now(), reason, now(), runId);
  }

  private log(runId: string, kind: string, text: string): void {
    const ts = now();
    const line = text.slice(0, 4000);
    this.db.insert("events", { run_id: runId, ts, kind, text: line });
    this.db.run("UPDATE runs SET last_heartbeat_at=? WHERE id=?", ts, runId);
    this.hub.emitEvent({ type: "log", run_id: runId, task_id: null, agent_id: "", kind, text: line.slice(0, 2000), ts });
  }
}

export function runEvents(db: Db, runId: string): { run: Row; events: Row[] } {
  const run = db.get("SELECT * FROM runs WHERE id=?", runId);
  if (!run) throw Object.assign(new Error("run not found"), { status: 404 });
  return { run, events: db.all("SELECT * FROM events WHERE run_id=? ORDER BY id", runId) };
}
