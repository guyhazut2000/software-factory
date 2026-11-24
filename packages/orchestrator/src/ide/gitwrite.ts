import { execFile } from "node:child_process";
import { HttpError, cleanRel } from "./paths.js";

/**
 * Git writes for "My workspace" only (ADR 7). argv via execFile (no shell), and only these subcommands.
 * Pushes always name origin and an explicit refs/heads/<b>:refs/heads/<b> refspec, never main/master/default.
 */
const ALLOW = new Set(["add", "restore", "rm", "commit", "for-each-ref", "symbolic-ref", "rev-parse", "check-ref-format", "branch", "switch", "status", "diff", "push"]);
const PROTECTED = new Set(["main", "master"]);
const MAX_PATHS = 1000;

function git(cwd: string, args: string[], timeout = 30_000): Promise<{ code: number; out: string; err: string }> {
  if (!ALLOW.has(args[0])) throw new HttpError(400, `git ${args[0]} is not allowed`);
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (e, out, err) => {
      const code = e ? (typeof (e as { code?: unknown }).code === "number" ? (e as unknown as { code: number }).code : 1) : 0;
      resolve({ code, out: String(out), err: String(err) });
    });
  });
}
async function ok(cwd: string, args: string[], timeout?: number): Promise<string> {
  const r = await git(cwd, args, timeout);
  if (r.code !== 0) throw new HttpError(400, `git ${args[0]}: ${(r.err || r.out).trim().slice(0, 300)}`);
  return r.out;
}

function paths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PATHS) throw new HttpError(400, "paths must be a non-empty array");
  return raw.map((p) => {
    const r = cleanRel(p);
    if (!r) throw new HttpError(400, "empty path");
    return r;
  });
}

/** A local branch name the client may use: never an option, and valid per `git check-ref-format --branch`. */
export async function branchName(root: string, raw: unknown): Promise<string> {
  if (typeof raw !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(raw) || raw.startsWith("-") || raw.includes("..")) throw new HttpError(400, "bad branch name");
  if ((await git(root, ["check-ref-format", "--branch", raw])).code !== 0) throw new HttpError(400, "bad branch name");
  return raw;
}

const hasRef = async (root: string, ref: string) => (await git(root, ["rev-parse", "--verify", "--quiet", ref])).code === 0;
async function current(root: string): Promise<string | null> {
  const r = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.code === 0 ? r.out.trim() : null;
}

export async function stage(root: string, b: Record<string, unknown>) {
  await ok(root, b.all === true ? ["add", "-A"] : ["add", "-A", "--", ...paths(b.paths)]);
  return { ok: true };
}

export async function unstage(root: string, b: Record<string, unknown>) {
  const ps = b.all === true ? ["."] : paths(b.paths);
  if (await hasRef(root, "HEAD")) await ok(root, ["restore", "--staged", "--", ...ps]);
  else await ok(root, ["rm", "-r", "-q", "--cached", "--", ...ps]); // no commit yet
  return { ok: true };
}

export async function commit(root: string, b: Record<string, unknown>) {
  const msg = typeof b.message === "string" ? b.message.trim() : "";
  if (!msg || msg.length > 10_000) throw new HttpError(400, "commit message is required");
  if ((await git(root, ["diff", "--cached", "--quiet"])).code === 0 && (await hasRef(root, "HEAD"))) throw new HttpError(400, "nothing staged to commit");
  await ok(root, ["commit", "-q", "-m", msg]);
  return { sha: (await ok(root, ["rev-parse", "HEAD"])).trim(), branch: await current(root) };
}

export async function branches(root: string) {
  const out = await ok(root, ["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(upstream:short)%1f%(HEAD)", "refs/heads", "refs/remotes/origin"]);
  const local: { name: string; sha: string; upstream: string | null; current: boolean }[] = [];
  const remote: { name: string; sha: string }[] = [];
  for (const l of out.split("\n").filter(Boolean)) {
    const [ref, sha, up, head] = l.split("\x1f");
    if (ref.startsWith("refs/heads/")) local.push({ name: ref.slice(11), sha, upstream: up || null, current: head === "*" });
    else if (!ref.endsWith("/HEAD")) remote.push({ name: ref.slice(20), sha });
  }
  return { current: await current(root), local, remote, protected: [...PROTECTED] };
}

async function refuseDirty(root: string) {
  const s = await ok(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (s.trim()) throw new HttpError(409, "you have uncommitted changes: commit or discard them before switching branches");
}

export async function createBranch(root: string, b: Record<string, unknown>) {
  const name = await branchName(root, b.name);
  if (await hasRef(root, `refs/heads/${name}`)) throw new HttpError(409, `branch ${name} already exists`);
  let from = "HEAD";
  if (b.from != null) {
    const f = await branchName(root, b.from);
    from = (await hasRef(root, `refs/heads/${f}`)) ? `refs/heads/${f}` : `refs/remotes/origin/${f}`;
    if (!(await hasRef(root, from))) throw new HttpError(404, `unknown branch ${f}`);
  }
  if (b.checkout === true) {
    await refuseDirty(root);
    await ok(root, ["switch", "-q", "--no-track", "-c", name, from]);
  } else await ok(root, ["branch", "--no-track", name, from]);
  return branches(root);
}

export async function checkout(root: string, b: Record<string, unknown>) {
  const name = await branchName(root, b.name);
  await refuseDirty(root);
  if (await hasRef(root, `refs/heads/${name}`)) await ok(root, ["switch", "-q", name]);
  else if (await hasRef(root, `refs/remotes/origin/${name}`)) await ok(root, ["switch", "-q", "--track", "-c", name, `refs/remotes/origin/${name}`]);
  else throw new HttpError(404, `unknown branch ${name}`);
  return branches(root);
}

/** Push a branch (default: the current one) to origin under the same name. Never main/master or the project's default branch. */
export async function push(root: string, b: Record<string, unknown>, defaultBranch?: string | null) {
  const name = b.branch != null ? await branchName(root, b.branch) : await current(root);
  if (!name) throw new HttpError(400, "HEAD is detached: check out a branch to push");
  if (PROTECTED.has(name) || name === defaultBranch) throw new HttpError(403, `pushing to ${name} is not allowed: push a feature branch and open a PR`);
  if (!(await hasRef(root, `refs/heads/${name}`))) throw new HttpError(404, `unknown branch ${name}`);
  await ok(root, ["push", "--porcelain", "--set-upstream", "origin", `refs/heads/${name}:refs/heads/${name}`], 120_000);
  return { pushed: name, remote: "origin" };
}
