import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const uid = () => crypto.randomUUID();
export const now = () => Date.now();
export const isWin = process.platform === "win32";

export function dataDir(): string {
  return process.env.SF_DATA_DIR ?? path.join(os.homedir(), ".software-factory");
}

/** Resolve an executable on PATH (honours PATHEXT on Windows). */
export function which(name: string): string | null {
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      const p2 = path.join(dir, name + ext);
      if (existsSync(p)) return p;
      if (existsSync(p2)) return p2;
    }
  }
  return null;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion. Never throws; missing binaries give code 127. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const exe = which(cmd) ?? cmd;
    const needsShell = isWin && /\.(cmd|bat)$/i.test(exe);
    const child = execFile(
      needsShell ? quoteWin(exe) : exe,
      needsShell ? args.map(quoteWin) : args,
      { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024, shell: needsShell, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : (err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === 127 ? `${cmd}: not found` : "") });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

function quoteWin(s: string): string {
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface Streaming {
  child: ChildProcess;
  done: Promise<number>;
  kill: () => void;
}

/** Spawn a long-running process, calling onLine for each stdout/stderr line. */
export function stream(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string; onLine: (line: string, isErr: boolean) => void },
): Streaming {
  const exe = which(argv[0]) ?? argv[0];
  const needsShell = isWin && /\.(cmd|bat)$/i.test(exe);
  const child = spawn(needsShell ? quoteWin(exe) : exe, needsShell ? argv.slice(1).map(quoteWin) : argv.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    shell: needsShell,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pump = (s: NodeJS.ReadableStream | null, isErr: boolean) => {
    let buf = "";
    s?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line) opts.onLine(line, isErr);
      }
    });
    s?.on("end", () => buf && opts.onLine(buf, isErr));
  };
  pump(child.stdout, false);
  pump(child.stderr, true);
  child.stdin?.on("error", () => {});
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  else child.stdin?.end();
  const done = new Promise<number>((resolve) => {
    child.on("error", (e) => {
      opts.onLine(`spawn error: ${e.message}`, true);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
  const kill = () => {
    if (isWin && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    else child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  };
  return { child, done, kill };
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
