import path from "node:path";
import crypto from "node:crypto";
import { Db } from "./db.js";
import { Hub } from "./hub.js";
import { Engine } from "./engine.js";
import { startServers } from "./server.js";
import { dataDir } from "./util.js";

const db = new Db(process.env.SF_DB ?? path.join(dataDir(), "factory.db"));
const hub = new Hub();
const engine = new Engine(db, hub);
const token = process.env.SF_API_TOKEN ?? crypto.randomBytes(16).toString("hex");
const lan = db.getSetting("runner", "sbx") === "sbx" || process.env.SF_AGENT_BIND === "0.0.0.0";

const s = await startServers(engine, {
  apiPort: Number(process.env.SF_PORT ?? 47821),
  agentPort: Number(process.env.SF_AGENT_PORT ?? 47822),
  token,
  // Sandboxes reach the host through host.docker.internal, so the agent listener must not be loopback-only in sbx mode.
  // It only serves unguessable per-run URLs; set SF_AGENT_BIND=127.0.0.1 to restrict it.
  agentBind: process.env.SF_AGENT_BIND ?? (lan ? "0.0.0.0" : "127.0.0.1"),
});
engine.agentPort = s.agentPort;
engine.start();
console.log(`SF_READY ${JSON.stringify({ port: s.apiPort, agentPort: s.agentPort, token })}`);

const quit = () => {
  engine.stop();
  s.close();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
