// Shared helpers for scripts/start.mjs and scripts/dev.mjs. Pure Node: works the same in cmd, PowerShell, bash and zsh.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const isWin = process.platform === "win32";
export const orchestratorBundle = path.join(root, "packages/orchestrator/dist/orchestrator.mjs");
export const uiDist = path.join(root, "apps/desktop/dist");

export function log(m) {
  console.log(`[factory] ${m}`);
}
export function die(m) {
  console.error(`\n[factory] ERROR: ${m}\n`);
  process.exit(1);
}

export function checkNode() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) die(`Node ${process.versions.node} is too old. Software Factory needs Node 22.13 or newer (it uses the built-in node:sqlite). Install it from https://nodejs.org or run: nvm install 22`);
}

export function pnpm(args, opts = {}) {
  return spawnSync("pnpm", args, { cwd: root, stdio: "inherit", shell: isWin, ...opts });
}

export function ensureInstalled() {
  if (existsSync(path.join(root, "node_modules")) && existsSync(path.join(root, "apps/desktop/node_modules"))) return;
  log("Dependencies are missing: running pnpm install (first run only)...");
  const r = pnpm(["install"]);
  if (r.status !== 0) die("pnpm install failed. Is pnpm installed? Try: npm install -g pnpm");
}

function newest(dir, skip = new Set(["node_modules", "dist"])) {
  let t = 0;
  if (!existsSync(dir)) return 0;
  for (const e of readdirSync(dir)) {
    if (skip.has(e)) continue;
    const p = path.join(dir, e);
    const s = statSync(p);
    t = Math.max(t, s.isDirectory() ? newest(p, skip) : s.mtimeMs);
  }
  return t;
}

const stale = (out, ...inputs) => !existsSync(out) || statSync(out).mtimeMs < Math.max(...inputs.map((i) => newest(i)));

export function ensureBuilt({ ui }) {
  if (stale(orchestratorBundle, path.join(root, "packages/orchestrator/src"), path.join(root, "packages/adapters/src"), path.join(root, "skills"))) {
    log("Building the orchestrator...");
    if (pnpm(["--filter", "@sf/orchestrator", "build"]).status !== 0) die("Orchestrator build failed.");
  }
  const index = path.join(uiDist, "index.html");
  if (ui && (stale(index, path.join(root, "apps/desktop/src")) || stale(index, path.join(root, "apps/desktop/index.html")))) {
    log("Building the UI...");
    if (pnpm(["--filter", "@sf/desktop", "build"]).status !== 0) die("UI build failed.");
  }
}

export function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

export function startOrchestrator(env) {
  const child = spawn(process.execPath, ["--no-warnings", orchestratorBundle], { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const ready = new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      buf += d;
      if (buf.includes("SF_READY")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`orchestrator exited with code ${code}`)));
  });
  return { child, ready };
}

export function openBrowser(url) {
  if (process.env.SF_NO_OPEN) return;
  const [cmd, args] = isWin ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => log(`Could not open a browser; open ${url} yourself.`)).unref();
  } catch {
    log(`Open ${url} in your browser.`);
  }
}

/** Kill children on Ctrl+C / termination, exit when any required child exits. */
export function superviseChildren(children) {
  let done = false;
  const stop = (code = 0) => {
    if (done) return;
    done = true;
    for (const c of children) {
      try {
        if (isWin && c.pid) spawnSync("taskkill", ["/pid", String(c.pid), "/t", "/f"], { stdio: "ignore" });
        else c.kill("SIGTERM");
      } catch { /* already gone */ }
    }
    setTimeout(() => process.exit(code), 300);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  for (const c of children) c.once("exit", (code) => { if (!done) { console.error(`[factory] a process exited (code ${code}); shutting down.`); stop(code ?? 1); } });
}
