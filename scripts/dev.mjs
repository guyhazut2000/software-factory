// `pnpm dev`: orchestrator + Vite with hot reload; the token is passed to both automatically.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { checkNode, die, ensureBuilt, ensureInstalled, isWin, log, openBrowser, portFree, root, startOrchestrator, superviseChildren } from "./lib.mjs";

checkNode();
ensureInstalled();
ensureBuilt({ ui: false });

const port = Number((process.env.SF_PORT ?? "").trim() || 47821);
if (!(await portFree(port))) die(`Port ${port} is already in use. Close the old process or set SF_PORT.`);
if (!(await portFree(1420))) die("Port 1420 (Vite) is already in use.");

const token = crypto.randomBytes(16).toString("hex");
const { child: orch, ready } = startOrchestrator({ SF_PORT: String(port), SF_API_TOKEN: token });
const vite = spawn("pnpm", ["--filter", "@sf/desktop", "dev"], { cwd: root, shell: isWin, stdio: "inherit", env: { ...process.env, VITE_SF_PORT: String(port), VITE_SF_TOKEN: token } });
superviseChildren([orch, vite]);
await ready.catch((e) => die(e.message));
const url = "http://localhost:1420/";
log(`Dev mode: ${url} (orchestrator on port ${port}; rebuild it with: pnpm --filter @sf/orchestrator build)`);
openBrowser(url);
