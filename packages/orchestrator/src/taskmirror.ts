import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db, Row } from "./db.js";
import { dataDir, now, slug } from "./util.js";

/** The local "workspace" git repo (no remote) that mirrors local tasks as markdown. See docs/PHASE2.md 2.3. */
export const workspaceRepoDir = () => process.env.SF_WORKSPACE_DIR ?? path.join(dataDir(), "workspace");

const STATUSES = ["queued", "working", "waiting_for_guy", "in_review", "done", "failed"];
const TYPES = ["code", "script", "manual", "review"];
const FIELDS = ["id", "title", "status", "type", "priority", "due", "labels", "assignee"] as const;

export const hashText = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function toMarkdown(t: Row): string {
  let labels: unknown = [];
  try {
    labels = JSON.parse(t.labels ?? "[]");
  } catch {
    /* keep [] */
  }
  const v: Record<string, unknown> = { id: t.id, title: t.title, status: t.status, type: t.type, priority: t.priority ?? null, due: t.due_at ?? null, labels, assignee: t.assignee_id ?? null };
  const fm = FIELDS.map((k) => `${k}: ${JSON.stringify(v[k])}`).join("\n");
  return `---\n${fm}\n---\n${t.body ?? ""}`.replace(/\n*$/, "\n");
}

export interface ParsedTask {
  id: string;
  title: string;
  status: string;
  type: string;
  priority: number | null;
  due_at: number | null;
  labels: string;
  assignee_id: string | null;
  body: string;
}

export function fromMarkdown(md: string): ParsedTask | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const raw = line.slice(i + 1).trim();
    try {
      fm[line.slice(0, i).trim()] = JSON.parse(raw);
    } catch {
      fm[line.slice(0, i).trim()] = raw;
    }
  }
  if (typeof fm.id !== "string" || !fm.id) return null;
  const num = (x: unknown) => (typeof x === "number" ? x : null);
  return {
    id: fm.id,
    title: String(fm.title ?? fm.id),
    status: STATUSES.includes(String(fm.status)) ? String(fm.status) : "queued",
    type: TYPES.includes(String(fm.type)) ? String(fm.type) : "manual",
    priority: num(fm.priority),
    due_at: num(fm.due),
    labels: JSON.stringify(Array.isArray(fm.labels) ? fm.labels.map(String) : []),
    assignee_id: typeof fm.assignee === "string" ? fm.assignee : null,
    body: m[2]!.replace(/\n$/, ""),
  };
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=Software Factory", "-c", "user.email=factory@localhost", "-c", "commit.gpgsign=false", ...a], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

export class TaskMirror {
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Db,
    public dir = workspaceRepoDir(),
    private debounceMs = 2000,
  ) {}

  /** Create the repo on first use: `git init`, no remote. */
  ensure(): void {
    for (const d of ["tasks", "automations", "notes"]) mkdirSync(path.join(this.dir, d), { recursive: true });
    if (!existsSync(path.join(this.dir, ".git"))) {
      git(this.dir, "init", "-q");
      writeFileSync(path.join(this.dir, "README.md"), "# Software Factory workspace\n\nLocal tasks (tasks/), automations (automations/) and notes. Managed by the app; edits here are re-imported on start.\n");
      git(this.dir, "add", "-A");
      git(this.dir, "commit", "-q", "-m", "workspace: init");
    }
  }

  private projectDir(projectId: string | null): string {
    if (!projectId) return "_loose";
    const p = this.db.get("SELECT name FROM projects WHERE id=?", projectId);
    return p ? slug(p.name) : "_loose";
  }

  relPathFor(t: Row): string {
    return path.posix.join("tasks", this.projectDir(t.project_id ?? null), `${t.id}-${slug(t.title ?? "")}.md`);
  }

  /** Write-through: SQLite row -> markdown file; commit is debounced. No-op for non-local tasks. */
  write(taskId: string, change = "update"): void {
    const t = this.db.get("SELECT * FROM tasks WHERE id=?", taskId);
    if (!t || t.source !== "local") return;
    this.ensure();
    const rel = this.relPathFor(t);
    if (t.md_path && t.md_path !== rel) rmSync(path.join(this.dir, t.md_path), { force: true });
    const md = toMarkdown(t);
    mkdirSync(path.dirname(path.join(this.dir, rel)), { recursive: true });
    writeFileSync(path.join(this.dir, rel), md);
    this.db.run("UPDATE tasks SET md_path=?, md_hash=? WHERE id=?", rel, hashText(md), taskId);
    this.queue(`task ${taskId}: ${change}`);
  }

  remove(taskId: string): void {
    const t = this.db.get("SELECT md_path FROM tasks WHERE id=?", taskId);
    if (!t?.md_path) return;
    rmSync(path.join(this.dir, t.md_path), { force: true });
    this.queue(`task ${taskId}: delete`);
  }

  queueCommit(msg: string): void {
    this.queue(msg);
  }

  private queue(msg: string): void {
    this.pending.push(msg);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
  }

  /** Commit pending changes now. Returns true when a commit was made. */
  flush(): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return false;
    const msgs = [...new Set(this.pending)];
    this.pending = [];
    try {
      git(this.dir, "add", "-A");
      if (!git(this.dir, "status", "--porcelain").trim()) return false;
      git(this.dir, "commit", "-q", "-m", msgs.length === 1 ? msgs[0]! : `tasks: ${msgs.length} changes\n\n${msgs.join("\n")}`);
      return true;
    } catch {
      return false;
    }
  }

  /** On start: re-import markdown files whose hash differs from SQLite (edited by hand or git-pulled). */
  importAll(): { imported: number } {
    this.ensure();
    let imported = 0;
    const root = path.join(this.dir, "tasks");
    const projects = this.db.all("SELECT id, name FROM projects");
    for (const pd of readdirSync(root, { withFileTypes: true })) {
      if (!pd.isDirectory()) continue;
      for (const f of readdirSync(path.join(root, pd.name))) {
        if (!f.endsWith(".md")) continue;
        const rel = path.posix.join("tasks", pd.name, f);
        const md = readFileSync(path.join(this.dir, rel), "utf8");
        const h = hashText(md);
        const p = fromMarkdown(md);
        if (!p) continue;
        const ex = this.db.get("SELECT id, source, md_hash FROM tasks WHERE id=?", p.id);
        if (ex && (ex.source !== "local" || ex.md_hash === h)) continue;
        const fields = { title: p.title, body: p.body, status: p.status, type: p.type, priority: p.priority, due_at: p.due_at, labels: p.labels, assignee_id: p.assignee_id, md_path: rel, md_hash: h, updated_at: now() };
        if (ex) this.db.update("tasks", p.id, fields);
        else {
          const proj = pd.name === "_loose" ? null : (projects.find((x) => slug(x.name) === pd.name)?.id ?? null);
          this.db.insert("tasks", { id: p.id, project_id: proj, source: "local", created_at: now(), ...fields });
        }
        imported++;
      }
    }
    return { imported };
  }
}
