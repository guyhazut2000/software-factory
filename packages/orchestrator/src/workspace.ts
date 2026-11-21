import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir, run, stream, type ExecResult, type Streaming } from "./util.js";
import { git, gitOk } from "./git.js";

export interface ExecOpts {
  env: Record<string, string>;
  stdin?: string;
  onLine: (line: string, isErr: boolean) => void;
}

export interface Workspace {
  kind: "sbx" | "worktree";
  /** Directory on the host (base clone or worktree). */
  hostDir: string;
  /** cwd to hand to the provider CLI ("." inside sbx). */
  cwd: string;
  exec(argv: string[], o: ExecOpts): Streaming;
  /** Run a shell command inside the workspace (git operations). */
  sh(cmd: string): Promise<ExecResult>;
  writeFiles(files: Record<string, string>): Promise<void>;
  push(branch: string, repo: string): Promise<ExecResult>;
  destroy(keep?: boolean): Promise<void>;
}

export const repoDirFor = (repo: string) => path.join(dataDir(), "repos", repo.replace("/", "__"));

/** Clone (or update) the base clone on the default branch. */
export async function ensureBaseClone(repo: string, base: string): Promise<string> {
  const dir = repoDirFor(repo);
  mkdirSync(path.dirname(dir), { recursive: true });
  if (!existsSync(path.join(dir, ".git"))) {
    await gitOk(["clone", `https://github.com/${repo}.git`, dir]);
  } else {
    await gitOk(["fetch", "--prune", "origin"], dir);
    await git(["checkout", "-q", base], dir, false);
    await git(["reset", "--hard", `origin/${base}`], dir, false);
  }
  installGitHooks(dir);
  return dir;
}

const PRE_PUSH = `#!/bin/sh
# Software Factory: never push to main/master
while read l_ref l_sha r_ref r_sha; do
  case "$r_ref" in refs/heads/main|refs/heads/master) echo "Software Factory: pushing to main/master is blocked" >&2; exit 1;; esac
done
exit 0
`;
const POST_COMMIT = `#!/bin/sh
# Software Factory: heartbeat on every commit
[ -n "$SF_HOOK_URL" ] && (curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"event":"commit"}' "$SF_HOOK_URL" >/dev/null 2>&1 || true)
exit 0
`;

export function installGitHooks(dir: string): void {
  const hooks = path.join(dir, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const [n, c] of [["pre-push", PRE_PUSH], ["post-commit", POST_COMMIT]] as const) {
    const f = path.join(hooks, n);
    if (!existsSync(f)) writeFileSync(f, c, { mode: 0o755 });
  }
}

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(root, rel))) {
    const r = path.join(rel, e);
    if (statSync(path.join(root, r)).isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out;
}

/** Skills folder shipped with the app (next to the bundle in production, repo root in dev). */
export function skillsRoot(): string {
  const candidates = [process.env.SF_SKILLS_DIR, path.join(path.dirname(process.argv[1] ?? ""), "skills"), path.resolve(process.cwd(), "skills"), path.resolve(process.cwd(), "../../skills")];
  return candidates.find((c) => c && existsSync(c)) ?? "";
}

export function skillFiles(names: string[] | "all"): Record<string, string> {
  const root = skillsRoot();
  const files: Record<string, string> = {};
  if (!root) return files;
  for (const f of listFiles(root)) {
    const skill = f.split(path.sep)[0];
    if (names !== "all" && !names.includes(skill)) continue;
    const content = readFileSync(path.join(root, f), "utf8");
    const posix = f.split(path.sep).join("/");
    files[`.claude/skills/${posix}`] = content; // Claude Code loads project skills from here
    files[`.sf/skills/${posix}`] = content; // other CLIs: referenced from the generated instructions
  }
  return files;
}

/* ---------------- host worktree (fallback, no isolation) ---------------- */
export async function createWorktree(repo: string, base: string, branch: string, taskId: string): Promise<Workspace> {
  const baseDir = await ensureBaseClone(repo, base);
  const dir = path.join(dataDir(), "work", taskId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  await git(["worktree", "prune"], baseDir, false);
  const remote = await git(["rev-parse", "--verify", `origin/${branch}`], baseDir, false);
  const start = remote.code === 0 ? `origin/${branch}` : `origin/${base}`;
  await gitOk(["worktree", "add", "-B", branch, dir, start], baseDir);
  return worktreeWs(dir, baseDir);
}

export function hostDirWs(dir: string): Workspace {
  return worktreeWs(dir, dir);
}

function worktreeWs(dir: string, baseDir: string): Workspace {
  return {
    kind: "worktree",
    hostDir: dir,
    cwd: dir,
    exec: (argv, o) => stream(argv, { cwd: dir, env: o.env, stdin: o.stdin, onLine: o.onLine }),
    sh: (cmd) => run(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", cmd] : ["-c", cmd], { cwd: dir }),
    async writeFiles(files) {
      for (const [rel, content] of Object.entries(files)) {
        const f = path.join(dir, rel);
        mkdirSync(path.dirname(f), { recursive: true });
        writeFileSync(f, content);
      }
      // keep orchestrator files out of commits
      const ex = await git(["rev-parse", "--git-path", "info/exclude"], dir, false);
      const exFile = path.resolve(dir, ex.stdout.trim());
      mkdirSync(path.dirname(exFile), { recursive: true });
      const cur = existsSync(exFile) ? readFileSync(exFile, "utf8") : "";
      if (!cur.includes(".sf/")) writeFileSync(exFile, cur + "\n.sf/\n.claude/skills/\n.cursor/mcp.json\n");
    },
    push: (branch) => git(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], dir),
    async destroy(keep) {
      if (keep) return;
      await git(["worktree", "remove", "--force", dir], baseDir, false);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ---------------- Docker Sandboxes (sbx), clone mode ---------------- */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function createSbx(opts: { repo: string; base: string; branch: string; taskId: string; sbxAgent: string; fresh: boolean }): Promise<Workspace> {
  const baseDir = await ensureBaseClone(opts.repo, opts.base);
  const name = `sf-${opts.taskId.slice(0, 8)}`;
  if (opts.fresh) {
    await run("sbx", ["stop", name]);
    await run("sbx", ["rm", "--force", name]);
  }
  const ls = await run("sbx", ["ls"]);
  if (!ls.stdout.includes(name)) {
    // Clone mode: the agent edits a private clone inside the microVM. Flags verified in docs.docker.com/ai/sandboxes/usage
    const r = await run("sbx", ["create", "--clone", "--name", name, opts.sbxAgent, baseDir], { timeoutMs: 600_000 });
    if (r.code !== 0) throw new Error(`sbx create failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  }
  const ws: Workspace = {
    kind: "sbx",
    hostDir: baseDir,
    cwd: ".",
    exec: (argv, o) => {
      const envArgs = Object.entries(o.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      return stream(["sbx", "exec", ...envArgs, name, ...argv], { stdin: o.stdin, onLine: o.onLine });
    },
    sh: (cmd) => run("sbx", ["exec", name, "sh", "-c", cmd], { timeoutMs: 300_000 }),
    async writeFiles(files) {
      const script = Object.entries(files)
        .map(([rel, c]) => `mkdir -p ${q(path.posix.dirname(rel))} && printf %s ${q(Buffer.from(c).toString("base64"))} | base64 -d > ${q(rel)}`)
        .join("\n");
      const r = await ws.sh(`${script}\nmkdir -p .git/info && grep -q '.sf/' .git/info/exclude 2>/dev/null || printf '.sf/\\n.claude/skills/\\n.cursor/mcp.json\\n' >> .git/info/exclude`);
      if (r.code !== 0) throw new Error(`writing files into sandbox failed: ${r.stderr.slice(0, 300)}`);
    },
    push: (branch, repo) => ws.sh(`git remote set-url origin https://github.com/${repo}.git && git push -u origin HEAD:refs/heads/${branch}`),
    async destroy(keep) {
      await run("sbx", ["stop", name]);
      if (!keep) await run("sbx", ["rm", "--force", name]);
    },
  };
  // Point origin at GitHub (the clone's origin is the host path) and move onto the task branch.
  const r = await ws.sh(`git remote set-url origin https://github.com/${opts.repo}.git && git fetch origin ${q(opts.base)} ${q(opts.branch)} 2>/dev/null; git checkout -B ${q(opts.branch)} $(git rev-parse --verify -q origin/${opts.branch} || echo origin/${opts.base})`);
  if (r.code !== 0) throw new Error(`sbx git setup failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return ws;
}

/** One-time network policy for sandboxes: GitHub + model providers. */
export async function applySbxPolicy(): Promise<string[]> {
  const log: string[] = [];
  const steps: string[][] = [["policy", "init", "balanced"]];
  for (const h of ["github.com", "api.github.com", "api.anthropic.com", "api.openai.com", "api2.cursor.sh", "registry.npmjs.org"]) steps.push(["policy", "allow", "network", h]);
  for (const s of steps) {
    const r = await run("sbx", s, { timeoutMs: 60_000 });
    log.push(`sbx ${s.join(" ")} -> ${r.code === 0 ? "ok" : (r.stderr || r.stdout).trim().slice(0, 120)}`);
  }
  return log;
}
