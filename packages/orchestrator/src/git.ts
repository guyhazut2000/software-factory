import { run, type ExecResult } from "./util.js";
import { getToken } from "./github.js";

/** Run git with GitHub auth injected through a one-off header (token never lands in .git/config). */
export async function git(args: string[], cwd?: string, auth = true): Promise<ExecResult> {
  const pre: string[] = ["-c", "credential.helper="];
  if (auth) {
    const t = await getToken();
    if (t) pre.push("-c", `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${t.token}`).toString("base64")}`);
  }
  return run("git", [...pre, ...args], { cwd, timeoutMs: 300_000, env: { GIT_TERMINAL_PROMPT: "0" } });
}

export async function gitOk(args: string[], cwd?: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout;
}

export async function aheadCount(cwd: string, base: string): Promise<number> {
  const r = await git(["rev-list", "--count", `origin/${base}..HEAD`], cwd, false);
  return r.code === 0 ? Number(r.stdout.trim()) : 0;
}

export async function commitAllIfDirty(cwd: string, message: string): Promise<boolean> {
  const st = await git(["status", "--porcelain"], cwd, false);
  if (!st.stdout.trim()) return false;
  await gitOk(["add", "-A"], cwd);
  await gitOk(["-c", "user.name=Software Factory", "-c", "user.email=factory@localhost", "commit", "-m", message], cwd);
  return true;
}
