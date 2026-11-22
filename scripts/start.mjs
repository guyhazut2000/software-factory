// `pnpm start`: build if needed, run the orchestrator (serves the UI too) and open the browser.
import crypto from "node:crypto";
import { checkNode, die, ensureBuilt, ensureInstalled, log, openBrowser, portFree, startOrchestrator, superviseChildren, uiDist } from "./lib.mjs";

checkNode();
ensureInstalled();
ensureBuilt({ ui: true });

const port = Number((process.env.SF_PORT ?? "").trim() || 47821);
if (!(await portFree(port))) die(`Port ${port} is already in use (an old Software Factory still running?). Close it, or pick another port: SF_PORT=47900 (cmd: set SF_PORT=47900& pnpm start).`);

const token = crypto.randomBytes(16).toString("hex");
const { child, ready } = startOrchestrator({ SF_PORT: String(port), SF_API_TOKEN: token, SF_UI_DIR: uiDist });
superviseChildren([child]);
await ready.catch((e) => die(e.message));
const url = `http://127.0.0.1:${port}/`;
log(`Software Factory is running: ${url}`);
log("Press Ctrl+C to stop.");
openBrowser(url);
