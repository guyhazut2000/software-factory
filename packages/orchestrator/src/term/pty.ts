import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { IPty } from "@lydell/node-pty";
import { uid } from "../util.js";

type PtyModule = typeof import("@lydell/node-pty");
let cached: PtyModule | null | undefined;
let loadError = "";

/** Load the native PTY module lazily; returns null (with ptyError()) if it is missing for this platform. */
export function loadPty(): PtyModule | null {
  if (cached !== undefined) return cached;
  try {
    const req = createRequire(import.meta.url);
    cached = req("@lydell/node-pty") as PtyModule;
    if (process.platform !== "win32") ensureSpawnHelperExecutable(req);
  } catch (e) {
    cached = null;
    loadError = e instanceof Error ? e.message : String(e);
  }
  return cached;
}
export const ptyError = () => loadError;

/** macOS/Linux: node-pty execs prebuilds/<plat>/spawn-helper; installers and npm tarballs can drop its exec bit. */
export function ensureSpawnHelperExecutable(req: NodeRequire): string | null {
  const plat = `${process.platform}-${process.arch}`;
  let helper: string;
  try {
    const wrapperEntry = req.resolve("@lydell/node-pty");
    let dir = path.dirname(createRequire(wrapperEntry).resolve(`@lydell/node-pty-${plat}`));
    while (!existsSync(path.join(dir, "package.json")) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    helper = path.join(dir, "prebuilds", plat, "spawn-helper");
  } catch {
    return null;
  }
  if (!existsSync(helper)) return null;
  try {
    accessSync(helper, constants.X_OK);
  } catch {
    try {
      chmodSync(helper, 0o755);
    } catch {
      /* read-only install dir: spawn will fail and surface the error */
    }
  }
  return helper;
}

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.COMSPEC || "cmd.exe", args: [] };
  return { file: process.env.SHELL || (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh"), args: ["-l"] };
}

/** Bounded ring of output chunks so a reloaded page can repaint the terminal. */
export class ReplayBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(readonly cap = 256 * 1024) {}
  push(data: string | Buffer) {
    const b = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.cap && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
    if (this.size > this.cap) {
      const only = this.chunks[0]!;
      this.chunks[0] = only.subarray(only.length - this.cap);
      this.size = this.cap;
    }
  }
  snapshot(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

export interface TermClient { send(data: Buffer | string): void }
export interface TermSession { id: string; cwd: string; label: string; workspace_id: string; shell: string; pid: number; created_at: number; cols: number; rows: number; exited: number | null; pty: IPty; replay: ReplayBuffer; clients: Set<TermClient> }
export type TermInfo = Omit<TermSession, "pty" | "replay" | "clients"> & { clients: number };

const clampDim = (n: unknown, d: number, max: number) => (Number.isInteger(n) && (n as number) > 0 ? Math.min(n as number, max) : d);

/** In-memory PTY sessions. They survive a page reload (replay buffer) and die with the orchestrator. */
export class TermRegistry {
  readonly sessions = new Map<string, TermSession>();
  constructor(private maxSessions = 16) {}

  create(o: { cwd: string; workspace_id: string; label?: string; cols?: number; rows?: number; shell?: { file: string; args: string[] } }): TermSession {
    const pty = loadPty();
    if (!pty) throw Object.assign(new Error(`terminal unavailable: ${ptyError()}`), { status: 503 });
    if (this.sessions.size >= this.maxSessions) throw Object.assign(new Error("too many terminals"), { status: 429 });
    const cwd = path.resolve(o.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw Object.assign(new Error("cwd does not exist"), { status: 400 });
    const sh = o.shell ?? defaultShell();
    const cols = clampDim(o.cols, 80, 500), rows = clampDim(o.rows, 24, 200);
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;
    delete env.SF_API_TOKEN;
    const p = pty.spawn(sh.file, sh.args, { name: "xterm-256color", cwd, cols, rows, env });
    const s: TermSession = { id: uid(), cwd, label: o.label ?? path.basename(cwd), workspace_id: o.workspace_id, shell: sh.file, pid: p.pid, created_at: Date.now(), cols, rows, exited: null, pty: p, replay: new ReplayBuffer(), clients: new Set() };
    p.onData((d) => {
      s.replay.push(d);
      const b = Buffer.from(d, "utf8");
      for (const c of s.clients) c.send(b);
    });
    p.onExit(({ exitCode }) => {
      s.exited = exitCode;
      const msg = JSON.stringify({ type: "exit", code: exitCode });
      for (const c of s.clients) c.send(msg);
    });
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string) {
    return this.sessions.get(id);
  }
  info(s: TermSession): TermInfo {
    const { pty: _p, replay: _r, clients, ...rest } = s; // eslint-disable-line @typescript-eslint/no-unused-vars
    return { ...rest, clients: clients.size };
  }
  list(): TermInfo[] {
    return [...this.sessions.values()].map((s) => this.info(s));
  }

  /** Attach a client: it first receives the replay buffer, then live output. Returns a detach function. */
  attach(id: string, c: TermClient): () => void {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error("unknown session"), { status: 404 });
    const snap = s.replay.snapshot();
    if (snap.length) c.send(snap);
    if (s.exited !== null) c.send(JSON.stringify({ type: "exit", code: s.exited }));
    s.clients.add(c);
    return () => void s.clients.delete(c);
  }

  /** Handle one client frame: binary/plain text = keystrokes, JSON {type:"resize"|"input"} = control. */
  input(id: string, data: Buffer, isBinary: boolean) {
    const s = this.sessions.get(id);
    if (!s || s.exited !== null) return;
    if (isBinary) return s.pty.write(data.toString("utf8"));
    let msg: { type?: string; cols?: unknown; rows?: unknown; data?: unknown };
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return s.pty.write(data.toString("utf8"));
    }
    if (msg.type === "resize") {
      s.cols = clampDim(msg.cols, s.cols, 500);
      s.rows = clampDim(msg.rows, s.rows, 200);
      s.pty.resize(s.cols, s.rows);
    } else if (msg.type === "input" && typeof msg.data === "string") s.pty.write(msg.data);
  }

  kill(id: string) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.exited === null) {
      try {
        s.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.sessions.delete(id);
    return true;
  }
  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
