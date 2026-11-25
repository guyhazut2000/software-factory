import path from "node:path";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import { Db } from "./db.js";
import { Hub } from "./hub.js";
import { Engine } from "./engine.js";
import { startServers } from "./server.js";
import { dataDir } from "./util.js";
import { backfillRoots } from "./projects.js";
import { AutomationMirror } from "./automirror.js";
import { TaskMirror } from "./taskmirror.js";

const db = new Db(process.env.SF_DB ?? path.join(dataDir(), "factory.db"));
backfillRoots(db);
const hub = new Hub();
const engine = new Engine(db, hub);
try {
  engine.mirror = new TaskMirror(db);
  engine.automirror = new AutomationMirror(db, engine.mirror);
  const { imported } = engine.mirror.importAll();
  const { imported: autoImported } = engine.automirror.importAll();
  if (imported) console.log(`workspace: re-imported ${imported} task file(s)`);
  if (autoImported) console.log(`workspace: re-imported ${autoImported} automation file(s)`);
} catch (e) {
  console.error(`workspace repo unavailable: ${(e as Error).message}`);
  engine.mirror = null;
}
const token = (process.env.SF_API_TOKEN ?? "").trim() || crypto.randomBytes(16).toString("hex");
const uiDir = (process.env.SF_UI_DIR ?? "").trim() || path.join(path.dirname(process.argv[1] ?? "."), "ui");
const lan = db.getSetting("runner", "sbx") === "sbx" || process.env.SF_AGENT_BIND === "0.0.0.0";

const s = await startServers(engine, {
  apiPort: Number(process.env.SF_PORT ?? 47821),
  agentPort: Number(process.env.SF_AGENT_PORT ?? 47822),
  token,
  uiDir: existsSync(path.join(uiDir, "index.html")) ? uiDir : undefined,
  // Sandboxes reach the host through host.docker.internal, so the agent listener must not be loopback-only in sbx mode.
  // It only serves unguessable per-run URLs; set SF_AGENT_BIND=127.0.0.1 to restrict it.
  agentBind: process.env.SF_AGENT_BIND ?? (lan ? "0.0.0.0" : "127.0.0.1"),
});
engine.agentPort = s.agentPort;
engine.start();
console.log(`SF_READY ${JSON.stringify({ port: s.apiPort, agentPort: s.agentPort, token })}`);

const quit = () => {
  engine.stop();
  engine.mirror?.flush();
  s.close();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
