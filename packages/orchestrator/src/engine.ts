import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAdapter, type AgentEvent } from "@sf/adapters";
import type { Db, Row } from "./db.js";
import type { Hub } from "./hub.js";
import { Scheduler } from "./scheduler.js";
import { Supervisor, defaultSupervisorConfig } from "./supervisor.js";
import { transition, type AgentState, type AgentTrigger } from "./state-machine.js";
import { checkToolUse } from "./guard.js";
import { TEMPLATES, ROLE_SKILLS } from "./templates.js";
import { buildInstructions } from "./instructions.js";
import { gh, getToken } from "./github.js";
import { aheadCount, commitAllIfDirty, git } from "./git.js";
import { createSbx, createWorktree, ensureBaseClone, skillFiles, type Workspace } from "./workspace.js";
import { formatFindings, runScanners } from "./scanners.js";
import type { FactoryHost } from "./mcp.js";
import { dataDir, now, slug, uid, which, stream } from "./util.js";

type Control = { kind: "ask" | "restart" | "stop" | "stuck" | "timeout" | "budget"; reason: string; fresh?: boolean };

interface Active {
  runId: string;
  agent: Row;
  task: Row | null;
  ws?: Workspace;
  kill?: () => void;
  control?: Control;
  done?: { ok: boolean; summary: string };
  lastText: string;
  errTail: string[];
  tokens: number;
  startedAt: number;
}

const HOOK_SCRIPT = `// Software Factory hook: forwards Claude Code hook events to the orchestrator; blocks dangerous tool calls.
const url = process.env.SF_HOOK_URL;
const kind = process.argv[2] || "event";
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  if (!url) process.exit(0);
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: kind, input }), signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    if (j.block) { console.error("Blocked by Software Factory: " + j.reason); process.exit(2); }
  } catch {}
  process.exit(0);
});
`;

const claudeHooks = () => {
  const h = (k: string) => [{ matcher: "*", hooks: [{ type: "command", command: `node .sf/hook.mjs ${k}` }] }];
  return JSON.stringify({ hooks: { PreToolUse: h("pre"), PostToolUse: h("post"), Stop: [{ hooks: [{ type: "command", command: "node .sf/hook.mjs stop" }] }] } });
};

export class Engine implements FactoryHost {
  scheduler = new Scheduler(3);
  supervisor = new Supervisor();
  active = new Map<string, Active>();
  private timers: NodeJS.Timeout[] = [];
  private lastSync = 0;
  private lastPr = 0;
  agentPort = 0;

  constructor(public db: Db, public hub: Hub) {
    this.supervisor.cfg = { ...defaultSupervisorConfig };
  }

  /* ---------- settings ---------- */
  settings() {
    const d = this.db;
    return {
      mode: d.getSetting<"quiet" | "eco" | "full">("mode", "full"),
      cap: d.getSetting("cap", 3),
      runner: d.getSetting<"sbx" | "worktree">("runner", "sbx"),
      allow_worktree: d.getSetting("allow_worktree", false),
      stopped: d.getSetting("stopped", false),
      agent_host: d.getSetting("agent_host", "host.docker.internal"),
      stuck_minutes: d.getSetting("stuck_minutes", 10),
      max_restarts: d.getSetting("max_restarts", 3),
      max_review_rounds: d.getSetting("max_review_rounds", 1),
    };
  }
  applySettings(): void {
    const s = this.settings();
    this.scheduler.cap = s.mode === "eco" ? 1 : s.mode === "quiet" ? 0 : Math.max(1, s.cap);
    this.supervisor.cfg.stuckMs = s.stuck_minutes * 60_000;
    this.supervisor.cfg.maxRestarts = s.max_restarts;
  }
  patchSettings(patch: Record<string, unknown>): void {
    for (const k of ["mode", "cap", "runner", "allow_worktree", "agent_host", "stuck_minutes", "max_restarts", "max_review_rounds"]) if (k in patch) this.db.setSetting(k, patch[k]);
    this.applySettings();
    this.hub.emitEvent({ type: "settings" });
  }

  start(): void {
    this.applySettings();
    // recover from a crash: anything "working" was interrupted
    for (const t of this.db.all("SELECT * FROM tasks WHERE status='working'")) this.db.update("tasks", t.id, { status: "queued", note: "Recovered after restart", updated_at: now() });
    this.db.run("UPDATE runs SET ended_at=?, exit_reason='crash' WHERE ended_at IS NULL", now());
    for (const a of this.db.all("SELECT * FROM agents")) this.db.update("agents", a.id, { state: a.enabled ? "idle" : "off", current_task_id: null });
    this.timers.push(setInterval(() => void this.tick().catch((e) => console.error("tick", e)), 4000));
    this.timers.push(setInterval(() => this.watch(), 15_000));
    void this.tick();
  }
  stop(): void {
    this.timers.forEach(clearInterval);
    for (const a of this.active.values()) a.kill?.();
  }

  /* ---------- agents ---------- */
  agentView(a: Row): Row {
    const parse = (s: string, d: unknown) => {
      try {
        return JSON.parse(s);
      } catch {
        return d;
      }
    };
    const today = new Date().setHours(0, 0, 0, 0);
    const used = this.db.get("SELECT COALESCE(SUM(input_tokens+output_tokens),0) AS n, COALESCE(SUM(usd),0) AS usd FROM costs WHERE agent_id=? AND created_at>=?", a.id, today);
    return { ...a, enabled: !!a.enabled, context: parse(a.context, {}), permissions: parse(a.permissions, []), skills: parse(a.skills, []), mcp: parse(a.mcp, {}), tokens_today: used?.n ?? 0, usd_today: used?.usd ?? 0 };
  }
  listAgents(): Row[] {
    return this.db.all("SELECT * FROM agents ORDER BY created_at").map((a) => this.agentView(a));
  }
  createAgent(p: Row): Row {
    const t = TEMPLATES.find((x) => x.key === p.template);
    const base = t ? { name: t.name, role: t.role, description: t.description, provider: t.provider, model: t.model, effort: t.effort, permissions: t.permissions, skills: t.skills, token_budget: t.token_budget, max_runtime_sec: t.max_runtime_sec } : {};
    const m: Row = { ...base, ...p };
    let name = String(m.name || "Agent");
    const taken = new Set(this.db.all("SELECT name FROM agents").map((r) => r.name));
    for (let i = 2; taken.has(name); i++) name = `${m.name}-${i}`;
    const row: Row = {
      id: uid(), name, role: m.role ?? "developer", description: m.description ?? "", provider: m.provider ?? "claude-code", model: m.model ?? "sonnet",
      effort: m.effort ?? "medium", context: JSON.stringify(m.context ?? {}), permissions: JSON.stringify(m.permissions ?? ["open_pr"]),
      token_budget: m.token_budget ?? null, max_runtime_sec: m.max_runtime_sec ?? 1800, cpu: m.cpu ?? 2, ram_mb: m.ram_mb ?? 4096,
      skills: JSON.stringify(m.skills ?? []), mcp: JSON.stringify(m.mcp ?? {}), enabled: m.enabled ? 1 : 0, state: m.enabled ? "idle" : "off", created_at: now(),
    };
    this.db.insert("agents", row);
    for (const p2 of this.db.all("SELECT repo FROM projects WHERE kind='github'")) void gh.ensureLabel(p2.repo, `agent:${name}`, "c5def5").catch(() => {});
    this.hub.emitEvent({ type: "agents" });
    return this.agentView(row);
  }
  updateAgent(id: string, p: Row): Row {
    const patch: Row = {};
    for (const k of ["name", "role", "description", "provider", "model", "effort", "token_budget", "max_runtime_sec", "cpu", "ram_mb"]) if (k in p) patch[k] = p[k];
    for (const k of ["context", "permissions", "skills", "mcp"]) if (k in p) patch[k] = JSON.stringify(p[k]);
    this.db.update("agents", id, patch);
    this.hub.emitEvent({ type: "agents" });
    return this.agentView(this.db.get("SELECT * FROM agents WHERE id=?", id)!);
  }
  deleteAgent(id: string): void {
    this.killAgent(id, { kind: "stop", reason: "agent deleted" });
    this.db.run("DELETE FROM agents WHERE id=?", id);
    this.hub.emitEvent({ type: "agents" });
  }
  setEnabled(id: string, on: boolean): void {
    const a = this.db.get("SELECT * FROM agents WHERE id=?", id);
    if (!a) return;
    if (!on) this.killAgent(id, { kind: "stop", reason: "agent switched off" });
    this.db.update("agents", id, { enabled: on ? 1 : 0, state: on ? (a.state === "off" ? "idle" : a.state) : "off" });
    this.hub.emitEvent({ type: "agents" });
  }
  restartAgent(id: string): void {
    if (!this.killAgent(id, { kind: "restart", reason: "manual restart", fresh: true })) {
      this.db.update("agents", id, { state: this.db.get("SELECT enabled FROM agents WHERE id=?", id)?.enabled ? "idle" : "off" });
      this.hub.emitEvent({ type: "agents" });
    }
  }
  private killAgent(agentId: string, c: Control): boolean {
    for (const a of this.active.values()) {
      if (a.agent.id === agentId) {
        a.control = c;
        a.kill?.();
        return true;
      }
    }
    return false;
  }
  stopAll(): void {
    this.db.setSetting("stopped", true);
    for (const a of this.active.values()) {
      a.control = { kind: "stop", reason: "stop-all" };
      a.kill?.();
    }
    this.hub.emitEvent({ type: "settings" });
  }
  resumeAll(): void {
    this.db.setSetting("stopped", false);
    this.hub.emitEvent({ type: "settings" });
  }
  private setState(id: string, trigger: AgentTrigger): void {
    const a = this.db.get("SELECT state, enabled FROM agents WHERE id=?", id);
    if (!a) return;
    let next: AgentState;
    try {
      next = transition(a.state, trigger);
    } catch {
      next = trigger === "finish" ? "idle" : (a.state as AgentState);
    }
    if (!a.enabled && trigger !== "disable") next = a.state === "working" ? "off" : next;
    this.db.update("agents", id, { state: next });
    this.hub.emitEvent({ type: "agents" });
  }

  /* ---------- logging ---------- */
  log(a: Active, kind: string, text: string): void {
    const ts = now();
    this.db.insert("events", { run_id: a.runId, ts, kind, text: text.slice(0, 4000) });
    this.hub.emitEvent({ type: "log", run_id: a.runId, task_id: a.task?.id ?? null, agent_id: a.agent.id, kind, text: text.slice(0, 2000), ts });
  }
  notify(title: string, body: string): void {
    this.hub.emitEvent({ type: "notify", title, body });
  }

  /* ---------- tasks ---------- */
  private taskLabels(t: Row): string[] {
    try {
      return JSON.parse(t.labels);
    } catch {
      return [];
    }
  }
  setTask(id: string, patch: Row): void {
    this.db.update("tasks", id, { ...patch, updated_at: now() });
    this.hub.emitEvent({ type: "tasks" });
  }
  private async setIssueStatus(project: Row, n: number | null, status: string): Promise<void> {
    if (!n || project.kind !== "github" || !project.repo) return;
    try {
      for (const s of ["backlog", "ready", "working", "blocked", "review", "done"]) if (s !== status) await gh.removeLabel(project.repo, n, `status:${s}`);
      await gh.addLabels(project.repo, n, [`status:${status}`]);
    } catch {
      /* labels are best effort */
    }
  }

  async createTaskFromIssue(project: Row, n: number, title: string, body: string, labels: string[]): Promise<Row> {
    const ex = this.db.get("SELECT * FROM tasks WHERE project_id=? AND issue_number=? AND kind='dev'", project.id, n);
    if (ex) return ex;
    const row: Row = { id: uid(), project_id: project.id, issue_number: n, title, body, kind: "dev", status: "queued", labels: JSON.stringify(labels), created_at: now(), updated_at: now() };
    this.db.insert("tasks", row);
    this.hub.emitEvent({ type: "tasks" });
    return row;
  }

  async syncIssues(): Promise<void> {
    if (!(await getToken())) return;
    for (const p of this.db.all("SELECT * FROM projects WHERE kind='github'")) {
      try {
        for (const i of await gh.listIssues(p.repo, "status:ready")) {
          if (i.pull_request) continue;
          await this.createTaskFromIssue(p, i.number, i.title, i.body ?? "", i.labels.map((l) => l.name));
        }
      } catch (e) {
        console.error("issue sync", p.repo, String(e));
      }
    }
  }

  async refreshPrs(): Promise<void> {
    for (const t of this.db.all("SELECT * FROM tasks WHERE kind='dev' AND status IN ('in_review') AND pr_number IS NOT NULL")) {
      const p = this.db.get("SELECT * FROM projects WHERE id=?", t.project_id);
      if (!p) continue;
      try {
        const s = await gh.prStatus(p.repo, t.pr_number);
        if (s.merged) {
          this.setTask(t.id, { status: "done", note: "Merged" });
          await this.setIssueStatus(p, t.issue_number, "done");
        } else if (s.state === "closed") this.setTask(t.id, { status: "failed", note: "PR closed without merge" });
        else if (t.note !== `CI ${s.ci}`) this.setTask(t.id, { note: `CI ${s.ci}` });
      } catch {
        /* ignore */
      }
    }
  }

  async mergeTask(id: string): Promise<void> {
    const t = this.db.get("SELECT * FROM tasks WHERE id=?", id);
    const p = t && this.db.get("SELECT * FROM projects WHERE id=?", t.project_id);
    if (!t || !p || !t.pr_number || p.kind !== "github") throw new Error("Task has no PR");
    await gh.mergePr(p.repo, t.pr_number);
    this.setTask(id, { status: "done", note: "Merged by Guy" });
    await this.setIssueStatus(p, t.issue_number, "done");
  }

  /* ---------- scheduling ---------- */
  private pickAgent(t: Row): Row | undefined {
    const labels = this.taskLabels(t);
    const pinned = labels.find((l) => l.startsWith("agent:"))?.slice(6);
    const busy = new Set([...this.active.values()].map((a) => a.agent.id));
    const cands = this.listAgents().filter((a) => {
      if (!a.enabled || busy.has(a.id)) return false;
      const okState = a.state === "idle" || (a.state === "waiting_for_guy" && t.assignee_id === a.id) || (a.state === "restarting" && t.assignee_id === a.id);
      if (!okState) return false;
      if (pinned && a.name !== pinned) return false;
      if (t.kind === "review") return a.permissions.includes("review") && a.id !== t.author_id;
      if (!a.permissions.includes("open_pr")) return false;
      if (t.assignee_id && t.assignee_id !== a.id && this.db.get("SELECT 1 AS x FROM agents WHERE id=? AND enabled=1", t.assignee_id) && t.restart_count > 0) return false;
      return true;
    });
    const withCli = cands.filter((a) => getAdapter(a.provider).executables.some((e) => which(e)));
    if (!withCli.length) return undefined;
    const score = (a: Row) => labels.filter((l) => a.skills.includes(l) || a.role === l).length * 10 + (t.assignee_id === a.id ? 5 : 0) - this.db.all("SELECT 1 FROM tasks WHERE assignee_id=? AND status IN ('working','in_review')", a.id).length;
    return withCli.sort((x, y) => score(y) - score(x))[0];
  }

  private overBudget(a: Row): boolean {
    return !!a.token_budget && a.tokens_today >= a.token_budget;
  }

  async tick(): Promise<void> {
    const s = this.settings();
    if (s.stopped || s.mode === "quiet") return;
    this.applySettings();
    if (Date.now() - this.lastSync > 30_000) {
      this.lastSync = Date.now();
      void this.syncIssues();
    }
    if (Date.now() - this.lastPr > 60_000) {
      this.lastPr = Date.now();
      void this.refreshPrs();
    }
    const tasks = this.db.all("SELECT * FROM tasks WHERE status='queued' ORDER BY CASE kind WHEN 'review' THEN 0 ELSE 1 END, created_at");
    for (const t of tasks) {
      if (this.scheduler.size >= this.scheduler.cap) break;
      if ([...this.active.values()].some((a) => a.task?.id === t.id)) continue;
      const agent = this.pickAgent(t);
      if (!agent) continue;
      if (this.overBudget(agent)) {
        if (t.note !== "Agent budget reached") this.setTask(t.id, { note: "Agent budget reached" });
        continue;
      }
      if (!this.scheduler.tryAcquire(agent.id)) continue;
      void this.execute(t, agent).catch((e) => console.error("execute", e)).finally(() => {
        this.scheduler.release(agent.id);
      });
    }
  }

  /** Supervisor sweep: runtime limits and stuck/loop/burn detection. */
  watch(): void {
    for (const a of this.active.values()) {
      if (a.control) continue;
      if (now() - a.startedAt > a.agent.max_runtime_sec * 1000) {
        a.control = { kind: "timeout", reason: `exceeded max runtime of ${a.agent.max_runtime_sec}s` };
        this.log(a, "supervisor", a.control.reason);
        a.kill?.();
        continue;
      }
      const v = this.supervisor.check(a.runId, now());
      if (!v.ok) {
        const esc = this.supervisor.escalate(a.task?.restart_count ?? 0);
        this.log(a, "supervisor", `${v.kind}: ${v.reason} -> ${esc}`);
        a.control = esc === "stop" ? { kind: "stuck", reason: v.reason } : { kind: "restart", reason: `${v.kind}: ${v.reason}`, fresh: esc === "restart" };
        this.setState(a.agent.id, "stall");
        a.kill?.();
      }
    }
  }

  /* ---------- running an agent ---------- */
  private env(a: Active): Record<string, string> {
    const url = `http://${this.settings().runner === "sbx" ? this.settings().agent_host : "127.0.0.1"}:${this.agentPort}`;
    return { SF_HOOK_URL: `${url}/hook/${a.runId}`, SF_RUN_ID: a.runId, SF_FACTORY_URL: `${url}/mcp/${a.runId}` };
  }

  private mcpConfig(a: Active, env: Record<string, string>): string {
    const servers: Record<string, unknown> = { factory: { type: "http", url: env.SF_FACTORY_URL } };
    let m: { github?: boolean; filesystem?: boolean; custom?: Record<string, unknown> } = {};
    try {
      m = typeof a.agent.mcp === "string" ? JSON.parse(a.agent.mcp || "{}") : (a.agent.mcp ?? {});
    } catch {
      /* default */
    }
    // GitHub/filesystem MCP are opt-in: their tool definitions cost tokens on every request.
    if (m.github) servers.github = { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } };
    if (m.filesystem) servers.filesystem = { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] };
    Object.assign(servers, m.custom ?? {});
    return JSON.stringify({ mcpServers: servers });
  }

  private agentSkills(agent: Row): string[] | "all" {
    if (agent.skills.length && agent.skills.every((s: string) => /^[a-z0-9-]+$/.test(s))) {
      const roleDefault = ROLE_SKILLS[agent.role];
      if (roleDefault === "all") return "all";
      return [...new Set([...(roleDefault ?? []), ...agent.skills])];
    }
    return ROLE_SKILLS[agent.role] ?? [];
  }

  private async execute(task: Row, agent: Row): Promise<void> {
    const project = this.db.get("SELECT * FROM projects WHERE id=?", task.project_id);
    const act: Active = { runId: uid(), agent, task, lastText: "", errTail: [], tokens: 0, startedAt: now() };
    this.active.set(act.runId, act);
    this.db.insert("runs", { id: act.runId, task_id: task.id, agent_id: agent.id, kind: task.kind, runner: this.settings().runner, started_at: now(), last_heartbeat_at: now() });
    this.supervisor.start(act.runId, now());
    this.setState(agent.id, agent.state === "restarting" ? "restarted" : agent.state === "waiting_for_guy" ? "answer" : "assign");
    this.db.update("agents", agent.id, { current_task_id: task.id });
    this.setTask(task.id, { status: "working", assignee_id: task.kind === "review" ? task.assignee_id : agent.id, note: "" });
    this.log(act, "system", `${agent.name} starts "${task.title}" (${agent.provider}/${agent.model}, ${this.settings().runner})`);
    try {
      if (!project) throw new Error("Project not found");
      if (project.kind !== "github") throw new Error(`Agents cannot run on ${project.kind} projects yet (planned in M9)`);
      if (task.kind === "review") await this.runReview(act, project);
      else await this.runDev(act, project);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(act, "error", msg);
      this.setTask(task.id, { status: "failed", note: msg.slice(0, 300) });
      this.notify("Task failed", `${task.title}: ${msg.slice(0, 120)}`);
    } finally {
      this.supervisor.end(act.runId);
      this.active.delete(act.runId);
      this.db.update("runs", act.runId, { ended_at: now(), exit_reason: act.control?.kind ?? (act.done?.ok ? "ok" : "error"), tokens: act.tokens });
      this.db.update("agents", agent.id, { current_task_id: null });
      const q = this.db.get("SELECT 1 AS x FROM questions WHERE task_id=? AND answer IS NULL", task.id);
      if (!q) this.setState(agent.id, "finish");
      this.hub.emitEvent({ type: "agents" });
      this.hub.emitEvent({ type: "costs" });
    }
  }

  private handleEvents(act: Active, events: AgentEvent[]): void {
    for (const ev of events) {
      if (ev.type === "text") {
        act.lastText = ev.text;
        this.log(act, "text", ev.text);
        this.supervisor.beat(act.runId, now());
      } else if (ev.type === "tool_call") {
        this.log(act, "tool", `${ev.name} ${JSON.stringify(ev.input ?? {}).slice(0, 300)}`);
        this.supervisor.beat(act.runId, now(), { tool: ev.name, input: ev.input });
      } else if (ev.type === "usage") {
        const n = ev.inputTokens + ev.outputTokens;
        act.tokens += n;
        this.db.insert("costs", { run_id: act.runId, agent_id: act.agent.id, input_tokens: ev.inputTokens, output_tokens: ev.outputTokens, usd: 0, created_at: now() });
        this.supervisor.beat(act.runId, now(), { tokens: n });
        const a = this.agentView(this.db.get("SELECT * FROM agents WHERE id=?", act.agent.id)!);
        if (!act.control && this.overBudget(a)) {
          act.control = { kind: "budget", reason: `daily token budget reached (${a.tokens_today}/${a.token_budget})` };
          this.log(act, "supervisor", act.control.reason);
          act.kill?.();
        }
        this.hub.emitEvent({ type: "costs" });
      } else if (ev.type === "cost") {
        this.db.insert("costs", { run_id: act.runId, agent_id: act.agent.id, input_tokens: 0, output_tokens: 0, usd: ev.usd, created_at: now() });
      } else if (ev.type === "done") {
        act.done = { ok: ev.ok, summary: ev.summary };
      }
    }
    this.db.update("runs", act.runId, { last_heartbeat_at: now(), tokens: act.tokens });
  }

  private spawnAgent(act: Active, ws: Workspace, argv: string[], stdin: string | undefined, env: Record<string, string>): Promise<number> {
    const adapter = getAdapter(act.agent.provider);
    const s = ws.exec(argv, {
      env,
      stdin,
      onLine: (line, isErr) => {
        if (isErr) {
          act.errTail = [...act.errTail.slice(-9), line];
          this.log(act, "stderr", line);
          this.supervisor.beat(act.runId, now());
          return;
        }
        const evs = adapter.parseLine(line);
        if (evs.length) this.handleEvents(act, evs);
        else if (!line.trim().startsWith("{")) this.log(act, "out", line);
        else this.supervisor.beat(act.runId, now());
      },
    });
    act.kill = s.kill;
    return s.done;
  }

  private async runDev(act: Active, project: Row): Promise<void> {
    const { task, agent } = act;
    const set = this.settings();
    const adapter = getAdapter(agent.provider);
    const branch = task!.branch ?? `sf/${task!.issue_number ?? task!.id.slice(0, 6)}-${slug(task!.title)}`;
    const fresh = !!task!.note?.includes("[fresh]");
    if (set.runner === "worktree" && !set.allow_worktree) throw new Error("Docker Sandboxes are selected but the unsafe worktree fallback is off. Set up sbx (Setup tab) or enable the fallback in Settings.");
    this.log(act, "system", set.runner === "sbx" ? "creating sandbox (clone mode)..." : "WARNING: running WITHOUT isolation (git worktree fallback)");
    const ws = set.runner === "sbx"
      ? await createSbx({ repo: project.repo, base: project.default_branch, branch, taskId: task!.id, sbxAgent: adapter.sbxAgent, fresh })
      : await createWorktree(project.repo, project.default_branch, branch, task!.id);
    act.ws = ws;
    this.setTask(task!.id, { branch });
    await this.setIssueStatus(project, task!.issue_number, "working");

    const env = this.env(act);
    const skillNames = this.agentSkills(agent);
    const files: Record<string, string> = {
      ".sf/hook.mjs": HOOK_SCRIPT,
      ".sf/mcp.json": this.mcpConfig(act, env),
      ".sf/claude-settings.json": claudeHooks(),
      ...skillFiles(skillNames),
    };
    const instructions = buildInstructions(project, agent, skillNames === "all" ? ["all skills"] : skillNames);
    const answers = this.db.all("SELECT body, answer FROM questions WHERE task_id=? AND answer IS NOT NULL ORDER BY asked_at", task!.id);
    const prompt = [
      `Task: ${task!.title}`,
      task!.issue_number ? `GitHub Issue #${task!.issue_number}` : "",
      task!.body ? `\n${task!.body}` : "",
      task!.summary ? `\nProgress so far (checkpoint):\n${task!.summary}` : "",
      answers.length ? `\nGuy's answers:\n${answers.map((a) => `Q: ${a.body}\nA: ${a.answer}`).join("\n")}` : "",
      "\nImplement this on the current branch and commit your work. Do not push or open a PR. Finish with a short summary.",
    ].filter(Boolean).join("\n");
    const cmd = adapter.buildCommand({
      prompt, systemPrompt: instructions, model: agent.model, effort: agent.effort, cwd: ws.cwd, sandboxed: ws.kind === "sbx",
      mcpConfigPath: ".sf/mcp.json", settingsPath: ".sf/claude-settings.json", factoryMcpUrl: env.SF_FACTORY_URL,
    });
    Object.assign(files, cmd.files ?? {});
    await ws.writeFiles(files);

    const runEnv = { ...env, ...(ws.kind === "worktree" ? { GITHUB_TOKEN: (await getToken())?.token ?? "" } : {}) };
    // Never leak the token into the sandbox env unless the agent opted into GitHub MCP.
    const code = await this.spawnAgent(act, ws, cmd.argv, cmd.stdin, ws.kind === "sbx" ? env : { ...runEnv, GITHUB_TOKEN: agent.mcp?.github ? (runEnv.GITHUB_TOKEN ?? "") : "" });

    await this.afterDevRun(act, project, ws, branch, code);
  }

  private async afterDevRun(act: Active, project: Row, ws: Workspace, branch: string, code: number): Promise<void> {
    const { task, agent } = act;
    const c = act.control;
    if (c) this.log(act, "system", `run ended: ${c.kind} (${c.reason})`);
    if (c?.kind === "ask") {
      this.setTask(task!.id, { status: "waiting_for_guy", note: "Waiting for Guy's answer" });
      this.setState(agent.id, "ask");
      await this.setIssueStatus(project, task!.issue_number, "blocked");
      await ws.destroy(true);
      return;
    }
    if (c?.kind === "restart" || (c?.kind === "stop" && c.reason === "stop-all") || c?.kind === "budget" || c?.kind === "timeout") {
      await commitAllIfDirty(ws.hostDir, "WIP checkpoint").catch(() => false);
      if (c.kind === "restart") {
        const n = (task!.restart_count ?? 0) + 1;
        if (n > this.supervisor.cfg.maxRestarts) {
          this.setTask(task!.id, { status: "failed", note: `Too many restarts (${n - 1}): ${c.reason}` });
          this.notify("Agent stopped", `${agent.name}: too many restarts on "${task!.title}"`);
          await ws.destroy(true);
          return;
        }
        this.setTask(task!.id, { status: "queued", restart_count: n, note: `Restart ${n}: ${c.reason}${c.fresh ? " [fresh]" : ""}` });
        this.setState(agent.id, "restart");
      } else {
        this.setTask(task!.id, { status: "queued", note: c.reason });
        if (c.kind === "budget") this.notify("Budget reached", `${agent.name}: ${c.reason}`);
      }
      await ws.destroy(true);
      return;
    }
    if (c?.kind === "stuck" || (c?.kind === "stop")) {
      this.setTask(task!.id, { status: "failed", note: c.reason });
      this.notify("Agent stopped", `${agent.name}: ${c.reason}`);
      await ws.destroy(true);
      return;
    }
    // normal exit
    if (code !== 0 && !act.done?.ok) {
      const tail = act.errTail.join(" | ").slice(0, 250) || `exit code ${code}`;
      this.setTask(task!.id, { status: "failed", note: tail });
      this.notify("Agent failed", `${agent.name}: ${tail.slice(0, 100)}`);
      await ws.destroy(true);
      return;
    }
    const summary = (act.done?.summary || act.lastText || "").slice(0, 2000);
    await ws.sh(`git add -A && git -c user.name="Software Factory" -c user.email=factory@localhost commit -m "WIP: ${task!.title.replace(/["$`\\]/g, "")}" || true`);
    const ahead = ws.kind === "worktree" ? await aheadCount(ws.hostDir, project.default_branch) : Number((await ws.sh(`git rev-list --count origin/${project.default_branch}..HEAD`)).stdout.trim() || 0);
    if (!ahead) {
      this.setTask(task!.id, { status: "failed", note: `No changes made. ${summary.slice(0, 200)}` });
      await ws.destroy(false);
      return;
    }
    const push = await ws.push(branch, project.repo);
    if (push.code !== 0) throw new Error(`push failed: ${(push.stderr || push.stdout).trim().slice(0, 300)}`);
    const owner = project.repo.split("/")[0];
    let pr = await gh.findPr(project.repo, owner, branch).catch(() => undefined);
    if (!pr) pr = await gh.createPr(project.repo, branch, project.default_branch, task!.title, `${task!.issue_number ? `Closes #${task!.issue_number}\n\n` : ""}${summary}\n\n_Opened by Software Factory agent **${agent.name}**._`);
    this.setTask(task!.id, { status: "in_review", pr_number: pr.number, pr_url: pr.html_url, author_id: agent.id, summary: summary.slice(0, 1000), note: "PR open" });
    await this.setIssueStatus(project, task!.issue_number, "review");
    this.log(act, "system", `PR #${pr.number}: ${pr.html_url}`);
    await ws.destroy(false);
    const reviewer = this.listAgents().find((a) => a.enabled && a.permissions.includes("review") && a.id !== agent.id);
    if (reviewer) {
      this.db.insert("tasks", { id: uid(), project_id: project.id, issue_number: task!.issue_number, title: `Review PR #${pr.number}: ${task!.title}`, body: "", kind: "review", status: "queued", author_id: agent.id, branch, pr_number: pr.number, pr_url: pr.html_url, labels: "[]", created_at: now(), updated_at: now() });
      this.hub.emitEvent({ type: "tasks" });
    } else this.setTask(task!.id, { note: "PR open: no reviewer agent enabled, ready for Guy" });
    this.notify("PR ready", `${agent.name} opened PR #${pr.number}: ${task!.title}`);
  }

  private async runReview(act: Active, project: Row): Promise<void> {
    const { task, agent } = act;
    const adapter = getAdapter(agent.provider);
    // Scanners first (free), on a host checkout of the PR branch. The LLM only sees findings + diff.
    await ensureBaseClone(project.repo, project.default_branch);
    const rev = await createWorktree(project.repo, project.default_branch, task!.branch!, `rev-${task!.id}`);
    let findingsText = "";
    let diff = "";
    try {
      const scan = await runScanners(rev.hostDir);
      findingsText = formatFindings(scan);
      this.log(act, "system", findingsText.split("\n")[0]);
      diff = (await git(["diff", `origin/${project.default_branch}...HEAD`, "--no-color", "-U3"], rev.hostDir, false)).stdout.slice(0, 60_000);
    } finally {
      await rev.destroy(false);
    }
    const dir = path.join(dataDir(), "runs", act.runId);
    mkdirSync(dir, { recursive: true });
    const skillNames = this.agentSkills(agent);
    const env = this.env(act);
    const prompt = `Review pull request #${task!.pr_number} for "${task!.title.replace(/^Review PR #\d+: /, "")}".\n\n## Scanner findings\n${findingsText}\n\n## Diff\n${diff || "(empty diff)"}\n\nGive a concise review and end with VERDICT: APPROVE or VERDICT: CHANGES_REQUESTED.`;
    const cmd = adapter.buildCommand({ prompt, systemPrompt: buildInstructions(project, agent, Array.isArray(skillNames) ? skillNames : []), model: agent.model, effort: agent.effort, cwd: dir, sandboxed: false, readOnly: true, factoryMcpUrl: env.SF_FACTORY_URL, mcpConfigPath: path.join(dir, "mcp.json"), maxTurns: 6 });
    writeFileSync(path.join(dir, "mcp.json"), this.mcpConfig(act, env));
    for (const [rel, content] of Object.entries(cmd.files ?? {})) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    }
    const hostWs: Workspace = { kind: "worktree", hostDir: dir, cwd: dir, exec: (argv, o) => stream(argv, { cwd: dir, env: o.env, stdin: o.stdin, onLine: o.onLine }), sh: async () => ({ code: 0, stdout: "", stderr: "" }), writeFiles: async () => {}, push: async () => ({ code: 0, stdout: "", stderr: "" }), destroy: async () => {} };
    act.ws = hostWs;
    const code = await this.spawnAgent(act, hostWs, cmd.argv, cmd.stdin, { ...env, GITHUB_TOKEN: "" });
    if (act.control) {
      this.setTask(task!.id, { status: act.control.kind === "restart" || act.control.kind === "budget" ? "queued" : "failed", note: act.control.reason });
      return;
    }
    if (code !== 0 && !act.done?.ok) throw new Error(act.errTail.join(" | ").slice(0, 250) || `reviewer exit code ${code}`);
    const text = act.done?.summary || act.lastText || "(no review output)";
    const approved = /VERDICT:\s*APPROVE/i.test(text) && !/CHANGES_REQUESTED/i.test(text);
    await gh.comment(project.repo, task!.pr_number!, `### Review by **${agent.name}** (${agent.provider}/${agent.model})\n\n${findingsText.split("\n")[0]}\n\n${text}`).catch(() => {});
    this.setTask(task!.id, { status: "done", note: approved ? "approved" : "changes requested" });
    const dev = this.db.get("SELECT * FROM tasks WHERE kind='dev' AND project_id=? AND pr_number=?", project.id, task!.pr_number);
    if (dev) {
      const rounds = this.db.all("SELECT 1 FROM tasks WHERE kind='review' AND pr_number=? AND project_id=?", task!.pr_number, project.id).length;
      if (!approved && rounds <= this.settings().max_review_rounds) {
        this.setTask(dev.id, { status: "queued", summary: `${dev.summary}\n\nReviewer feedback to address:\n${text.slice(0, 1500)}`, note: "Addressing review feedback" });
      } else this.setTask(dev.id, { note: approved ? "Approved by reviewer: ready for Guy to merge" : "Reviewer requested changes: needs Guy" });
      this.notify(approved ? "PR approved by reviewer" : "Review: changes requested", task!.title);
    }
  }

  /* ---------- chief chat ---------- */
  async chat(projectId: string | null, text: string): Promise<void> {
    const chief = this.listAgents().find((a) => a.role === "chief" && a.enabled);
    const mid = uid();
    this.db.insert("messages", { id: mid, channel: "chat", project_id: projectId, from_id: null, to_id: chief?.id ?? null, body: text, created_at: now() });
    this.hub.emitEvent({ type: "messages" });
    const reply = (body: string) => {
      this.db.insert("messages", { id: uid(), channel: "chat", project_id: projectId, from_id: chief?.id ?? "system", to_id: null, body, created_at: now() });
      this.hub.emitEvent({ type: "messages" });
    };
    if (!chief) return reply("No Chief agent is enabled. Open the Agents tab, add the Chief template and switch it on.");
    if (this.settings().stopped) return reply("The factory is stopped (stop-all). Resume it first.");
    if (this.active.has(`chief:${chief.id}`) || [...this.active.values()].some((a) => a.agent.id === chief.id)) return reply("I'm still busy with the previous message.");
    const adapter = getAdapter(chief.provider);
    if (!adapter.executables.some((e) => which(e))) return reply(`The ${adapter.executables[0]} CLI is not installed. See the Setup tab.`);
    const project = projectId ? this.db.get("SELECT * FROM projects WHERE id=?", projectId) : undefined;
    const act: Active = { runId: uid(), agent: chief, task: null, lastText: "", errTail: [], tokens: 0, startedAt: now() };
    this.active.set(act.runId, act);
    this.db.insert("runs", { id: act.runId, task_id: null, agent_id: chief.id, kind: "chat", runner: "host", started_at: now(), last_heartbeat_at: now() });
    this.supervisor.start(act.runId, now());
    this.setState(chief.id, "assign");
    try {
      let cwd = path.join(dataDir(), "chief");
      if (project?.kind === "github") cwd = await ensureBaseClone(project.repo, project.default_branch).catch(() => cwd);
      else if (project?.kind === "folder" && project.root_path) cwd = project.root_path;
      mkdirSync(cwd, { recursive: true });
      const hist = this.db.all("SELECT * FROM messages WHERE channel='chat' AND COALESCE(project_id,'')=COALESCE(?,'') ORDER BY created_at DESC LIMIT ?", projectId, Math.max(2, Math.min(40, chief.context.history_size ?? 12))).reverse();
      const prompt = [
        project ? `Active project: ${project.repo ?? project.name} (${project.kind}, project_id=${project.id}).${project.kind === "github" ? " Use this project_id with create_issue." : " This project has no GitHub repo, so create_issue is not available for it."}` : "No project is selected. Ask Guy to pick one before creating issues.",
        "Conversation so far:",
        ...hist.slice(0, -1).map((m) => `${m.from_id === null ? "Guy" : "Chief"}: ${m.body}`),
        `Guy: ${text}`,
      ].join("\n");
      const env = this.env(act);
      const dir = path.join(dataDir(), "runs", act.runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "mcp.json"), this.mcpConfig(act, env));
      const cmd = adapter.buildCommand({ prompt, systemPrompt: buildInstructions(project, chief, []), model: chief.model, effort: chief.effort, cwd, sandboxed: false, readOnly: true, mcpConfigPath: path.join(dir, "mcp.json"), factoryMcpUrl: env.SF_FACTORY_URL, maxTurns: 12 });
      const ws: Workspace = { kind: "worktree", hostDir: cwd, cwd, exec: (argv, o) => stream(argv, { cwd, env: o.env, stdin: o.stdin, onLine: o.onLine }), sh: async () => ({ code: 0, stdout: "", stderr: "" }), writeFiles: async () => {}, push: async () => ({ code: 0, stdout: "", stderr: "" }), destroy: async () => {} };
      act.ws = ws;
      const texts: string[] = [];
      const orig = act.lastText;
      void orig;
      const code = await this.spawnAgent(act, ws, cmd.argv, cmd.stdin, { ...env, GITHUB_TOKEN: "" });
      void texts;
      const out = act.done?.summary || act.lastText;
      if (act.control?.kind === "ask") return; // question already queued in the inbox
      if (code !== 0 && !out) reply(`Chief failed: ${act.errTail.join(" | ").slice(0, 300) || `exit code ${code}`}`);
      else reply(out || "(no reply)");
    } catch (e) {
      reply(`Chief failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.supervisor.end(act.runId);
      this.active.delete(act.runId);
      this.db.update("runs", act.runId, { ended_at: now(), exit_reason: "ok", tokens: act.tokens });
      this.setState(chief.id, "finish");
      this.hub.emitEvent({ type: "costs" });
    }
  }

  /* ---------- questions ---------- */
  async answerQuestion(id: string, answer: string): Promise<void> {
    const q = this.db.get("SELECT * FROM questions WHERE id=?", id);
    if (!q || q.answer) return;
    this.db.update("questions", id, { answer, answered_at: now() });
    this.db.insert("messages", { id: uid(), channel: "chat", task_id: q.task_id, project_id: q.project_id, from_id: null, to_id: q.agent_id, body: `(answer) ${answer}`, created_at: now() });
    if (q.task_id) {
      const t = this.db.get("SELECT * FROM tasks WHERE id=?", q.task_id);
      if (t && t.status === "waiting_for_guy") this.setTask(t.id, { status: "queued", note: "Answered, resuming" });
      const p = t && this.db.get("SELECT * FROM projects WHERE id=?", t.project_id);
      if (p && t) await this.setIssueStatus(p, t.issue_number, "working");
    } else if (q.project_id) {
      void this.chat(q.project_id, `(my answer to your question "${q.body}") ${answer}`);
    }
    this.hub.emitEvent({ type: "questions" });
    this.hub.emitEvent({ type: "messages" });
  }

  /* ---------- FactoryHost (MCP tools) ---------- */
  private act(runId: string): Active {
    const a = this.active.get(runId);
    if (!a) throw new Error("Run is not active");
    return a;
  }
  async getTaskContext(runId: string): Promise<unknown> {
    const a = this.act(runId);
    if (!a.task) return { note: "chat session: no task" };
    const t = this.db.get("SELECT * FROM tasks WHERE id=?", a.task.id)!;
    return { title: t.title, body: t.body, issue: t.issue_number, branch: t.branch, summary: t.summary, restart_count: t.restart_count, answers: this.db.all("SELECT body AS question, answer FROM questions WHERE task_id=? AND answer IS NOT NULL", t.id) };
  }
  async reportProgress(runId: string, summary: string, percent?: number): Promise<string> {
    const a = this.act(runId);
    this.supervisor.beat(runId, now());
    this.log(a, "progress", `${percent != null ? `[${percent}%] ` : ""}${summary}`);
    if (a.task) this.setTask(a.task.id, { summary: summary.slice(0, 1500), note: percent != null ? `${percent}%` : a.task.note });
    return "ok";
  }
  async createIssue(runId: string, args: { title: string; body: string; labels?: string[]; agent?: string; project_id?: string }): Promise<string> {
    const a = this.act(runId);
    if (!a.agent.permissions.includes("create_issue")) throw new Error("Only agents with the create_issue permission (Chief) may create issues");
    const pid = args.project_id ?? a.task?.project_id;
    const p = pid && this.db.get("SELECT * FROM projects WHERE id=?", pid);
    if (!p) throw new Error("Unknown project_id");
    if (p.kind !== "github") throw new Error(`Project ${p.name} is a ${p.kind} project with no GitHub repo`);
    const labels = [...(args.labels ?? []), "status:ready", ...(args.agent ? [`agent:${args.agent}`] : [])];
    const issue = await gh.createIssue(p.repo, args.title, args.body, labels);
    await this.createTaskFromIssue(p, issue.number, args.title, args.body, labels);
    this.log(a, "system", `created issue #${issue.number}: ${args.title}`);
    return `Created issue #${issue.number} ${issue.html_url}`;
  }
  async askGuy(runId: string, question: string): Promise<string> {
    const a = this.act(runId);
    const id = uid();
    this.db.insert("questions", { id, task_id: a.task?.id ?? null, agent_id: a.agent.id, project_id: a.task?.project_id ?? null, body: question, asked_at: now() });
    this.db.insert("messages", { id: uid(), channel: "chat", task_id: a.task?.id ?? null, from_id: a.agent.id, to_id: null, project_id: a.task?.project_id ?? null, body: `(question) ${question}`, created_at: now() });
    a.control = { kind: "ask", reason: question };
    this.log(a, "question", question);
    this.notify(`${a.agent.name} needs you`, question.slice(0, 140));
    this.hub.emitEvent({ type: "questions" });
    setTimeout(() => a.kill?.(), 1500); // let the tool result flush, then pause the run
    return "Question queued for Guy. The task is paused; you will be resumed with the answer. Stop working now.";
  }
  async requestRestart(runId: string, reason: string, summary?: string): Promise<string> {
    const a = this.act(runId);
    if (summary && a.task) this.setTask(a.task.id, { summary: summary.slice(0, 1500) });
    a.control = { kind: "restart", reason: `agent requested: ${reason}`, fresh: true };
    this.setState(a.agent.id, "restart");
    setTimeout(() => a.kill?.(), 1500);
    return "Restart scheduled from checkpoint. Stop working now.";
  }
  async sendMessage(runId: string, to: string, body: string): Promise<string> {
    const a = this.act(runId);
    const target = to.toLowerCase() === "chief" ? this.db.get("SELECT * FROM agents WHERE role='chief'") : this.db.get("SELECT * FROM agents WHERE lower(name)=lower(?)", to);
    this.db.insert("messages", { id: uid(), channel: "bus", task_id: a.task?.id ?? null, from_id: a.agent.id, to_id: target?.id ?? to, project_id: a.task?.project_id ?? null, body, created_at: now() });
    this.hub.emitEvent({ type: "messages" });
    return target ? `Delivered to ${target.name} (logged on the bus)` : `No agent named ${to}; message logged`;
  }
  async board(): Promise<unknown> {
    return {
      agents: this.listAgents().map((a) => ({ name: a.name, role: a.role, state: a.state, skills: a.skills })),
      tasks: this.db.all("SELECT id,title,status,issue_number,pr_number FROM tasks WHERE kind='dev' ORDER BY created_at DESC LIMIT 30"),
    };
  }

  /* ---------- hooks (Claude Code PreToolUse / PostToolUse / Stop, git hooks) ---------- */
  hook(runId: string, body: { event?: string; input?: { tool_name?: string; tool_input?: Record<string, unknown> } }): { block: boolean; reason?: string } {
    const a = this.active.get(runId);
    if (!a) return { block: false };
    const ev = body.event ?? "event";
    if (ev === "pre") {
      const r = checkToolUse(body.input?.tool_name ?? "", body.input?.tool_input);
      if (r.block) this.log(a, "blocked", `${body.input?.tool_name}: ${r.reason}`);
      return r;
    }
    this.supervisor.beat(runId, now(), ev === "post" ? { tool: body.input?.tool_name, input: body.input?.tool_input } : {});
    return { block: false };
  }
}
