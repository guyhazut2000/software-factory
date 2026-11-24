import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { activity } from "./activity.js";
import type { Engine } from "./engine.js";
import { handleMcp } from "./mcp.js";
import { healthChecks } from "./health.js";
import { TEMPLATES } from "./templates.js";
import { bootstrapLabels, getToken, gh, setToken } from "./github.js";
import { ensureBaseClone, applySbxPolicy, repoDirFor } from "./workspace.js";
import { newLocalProject, projectPatch } from "./projects.js";
import { ideRoute } from "./ide/routes.js";
import { TermRegistry } from "./term/pty.js";
import { termRoute } from "./term/routes.js";
import { now, uid } from "./util.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ALLOWED_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"]);

async function body(req: http.IncomingMessage): Promise<J> {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 5_000_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

export function startServers(engine: Engine, o: { apiPort: number; agentPort: number; token: string; agentBind: string; uiDir?: string }): Promise<{ apiPort: number; agentPort: number; close: () => void }> {
  const { db, hub } = engine;
  const terms = new TermRegistry();

  const state = () => ({
    agents: engine.listAgents(),
    projects: db.all("SELECT * FROM projects ORDER BY created_at"),
    tasks: db.all("SELECT * FROM tasks WHERE type<>'review' ORDER BY created_at DESC LIMIT 300").map((t) => ({ ...t, running: [...engine.active.values()].some((a) => a.task?.id === t.id) })),
    reviews: db.all("SELECT id,title,status,note,pr_number,project_id FROM tasks WHERE type='review' ORDER BY created_at DESC LIMIT 50"),
    questions: db.all("SELECT * FROM questions WHERE answer IS NULL ORDER BY asked_at"),
    settings: engine.settings(),
    running: [...engine.active.values()].map((a) => ({ run_id: a.runId, agent_id: a.agent.id, task_id: a.task?.id ?? null, started_at: a.startedAt, tokens: a.tokens })),
    templates: TEMPLATES,
  });

  async function route(method: string, url: URL, b: J): Promise<unknown> {
    const p = url.pathname;
    const seg = p.split("/").filter(Boolean); // api, x, id, action
    const id = seg[2];
    const act = seg[3];
    if (p === "/api/state") return state();
    if (p === "/api/health") return healthChecks();
    if (p === "/api/activity" && method === "GET") {
      const q = url.searchParams;
      return activity(db, { project: q.get("project"), agent: q.get("agent"), limit: Number(q.get("limit") ?? 20) || 20 });
    }
    if (p === "/api/auth" && method === "GET") {
      const t = await getToken();
      if (!t) return { connected: false };
      try {
        return { connected: true, source: t.source, user: (await gh.user()).login };
      } catch (e) {
        return { connected: false, error: String(e) };
      }
    }
    if (p === "/api/auth/token") {
      setToken(b.token ?? null);
      return { ok: true };
    }
    if (seg[1] === "ws") return ideRoute(db, method, url, b, engine);
    if (seg[1] === "term") return termRoute(db, terms, method, url, b, (id) => engine.runningAgent(id), (id) => engine.agentWorkspace(id));
    if (p === "/api/repos") return gh.listRepos();
    if (p === "/api/sbx/policy" && method === "POST") return applySbxPolicy();
    if (p === "/api/settings" && method === "PUT") {
      engine.patchSettings(b);
      return engine.settings();
    }
    if (p === "/api/stop-all") {
      engine.stopAll();
      return { ok: true };
    }
    if (p === "/api/resume") {
      engine.resumeAll();
      return { ok: true };
    }
    if (p === "/api/projects" && method === "POST" && (b.kind === "folder" || b.kind === "none")) {
      const row = newLocalProject(b);
      if (row.root_path && db.get("SELECT 1 AS x FROM projects WHERE root_path=? AND kind='folder'", row.root_path)) throw new Error("That folder is already a project");
      db.insert("projects", row);
      hub.emitEvent({ type: "projects" });
      return row;
    }
    if (p === "/api/projects" && method === "POST") {
      let repo = b.repo as string | undefined;
      let r;
      if (b.create) r = await gh.createRepo(b.create.name, b.create.private !== false, b.create.description ?? "");
      else if (repo) r = await gh.getRepo(repo);
      else throw new Error("repo or create required");
      repo = r.full_name;
      const ex = db.get("SELECT * FROM projects WHERE repo=?", repo);
      if (ex) return ex;
      const row = { id: uid(), name: repo.split("/")[1], kind: "github", repo, root_path: repoDirFor(repo), default_branch: r.default_branch, instructions: "", created_at: now() };
      db.insert("projects", row);
      hub.emitEvent({ type: "projects" });
      void bootstrapLabels(repo, engine.listAgents().map((a) => a.name)).catch((e) => console.error("labels", String(e)));
      void ensureBaseClone(repo, r.default_branch).catch((e) => console.error("clone", String(e)));
      return row;
    }
    if (seg[1] === "projects" && id) {
      if (method === "PUT") {
        const pr = db.get("SELECT * FROM projects WHERE id=?", id);
        if (!pr) throw new Error("project not found");
        const patch = projectPatch(db, pr, b);
        if (Object.keys(patch).length) db.update("projects", id, patch);
        hub.emitEvent({ type: "projects" });
        return { ok: true };
      }
      if (method === "DELETE") {
        db.run("DELETE FROM projects WHERE id=?", id);
        hub.emitEvent({ type: "projects" });
        return { ok: true };
      }
      if (act === "labels") {
        const pr = db.get("SELECT * FROM projects WHERE id=?", id);
        if (pr?.kind !== "github") throw new Error("Labels only apply to GitHub projects");
        await bootstrapLabels(pr!.repo, engine.listAgents().map((a) => a.name));
        return { ok: true };
      }
    }
    if (p === "/api/agents" && method === "POST") return engine.createAgent(b);
    if (seg[1] === "agents" && id) {
      if (method === "PUT") return engine.updateAgent(id, b);
      if (method === "DELETE") return engine.deleteAgent(id), { ok: true };
      if (act === "toggle") return engine.setEnabled(id, !!b.on), { ok: true };
      if (act === "restart") return engine.restartAgent(id), { ok: true };
      if (act === "recreate-sandbox" && method === "POST") return engine.recreateSandbox(id);
      if (act === "clone") {
        const a = engine.listAgents().find((x) => x.id === id)!;
        return engine.createAgent({ ...a, name: `${a.name} copy`, enabled: false, id: undefined });
      }
    }
    if (p === "/api/tasks" && method === "POST") {
      const pr = b.project_id ? db.get("SELECT * FROM projects WHERE id=?", b.project_id) : null;
      if (b.project_id && !pr) throw new Error("project not found");
      if (!pr || b.source === "local" || pr.kind !== "github" || (b.type && b.type !== "code")) return engine.createLocalTask(b);
      const labels = ["status:ready", ...(b.agent ? [`agent:${b.agent}`] : [])];
      const issue = await gh.createIssue(pr.repo, b.title, b.body ?? "", labels);
      return engine.createTaskFromIssue(pr, issue.number, b.title, b.body ?? "", labels);
    }
    if (seg[1] === "tasks" && id) {
      if (!act && method === "PUT") return engine.updateLocalTask(id, b);
      if (act === "complete" && method === "POST") return engine.completeTask(id, b.done !== false), { ok: true };
      if (act === "merge") return await engine.mergeTask(id), { ok: true };
      if (act === "retry") return engine.setTask(id, { status: "queued", restart_count: 0, note: "Retry" }), { ok: true };
      if (act === "stop") {
        for (const a of engine.active.values()) if (a.task?.id === id) { a.control = { kind: "stop", reason: "stopped by Guy" }; a.kill?.(); }
        return { ok: true };
      }
      if (act === "log") {
        const runs = db.all("SELECT id FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 3", id).map((r) => r.id);
        if (!runs.length) return [];
        return db.all(`SELECT * FROM events WHERE run_id IN (${runs.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 300`, ...runs).reverse();
      }
    }
    if (p === "/api/logs") return db.all("SELECT e.*, r.agent_id, r.task_id FROM events e JOIN runs r ON r.id=e.run_id ORDER BY e.id DESC LIMIT 200").reverse();
    if (p === "/api/messages") return db.all("SELECT * FROM messages WHERE (channel=? ) AND COALESCE(project_id,'')=COALESCE(?,'') ORDER BY created_at DESC LIMIT 100", url.searchParams.get("channel") ?? "chat", url.searchParams.get("project_id") || null).reverse();
    if (p === "/api/bus") return db.all("SELECT * FROM messages WHERE channel='bus' ORDER BY created_at DESC LIMIT 100").reverse();
    if (p === "/api/chat" && method === "POST") {
      void engine.chat(b.project_id ?? null, String(b.text));
      return { ok: true };
    }
    if (seg[1] === "questions" && id && act === "answer") return await engine.answerQuestion(id, String(b.answer)), { ok: true };
    if (p === "/api/costs") {
      const per_agent = db.all("SELECT a.name, a.id, COALESCE(SUM(c.input_tokens),0) AS input_tokens, COALESCE(SUM(c.output_tokens),0) AS output_tokens, COALESCE(SUM(c.usd),0) AS usd FROM agents a LEFT JOIN costs c ON c.agent_id=a.id GROUP BY a.id");
      const per_day = db.all("SELECT date(created_at/1000,'unixepoch','localtime') AS day, SUM(input_tokens+output_tokens) AS tokens, SUM(usd) AS usd FROM costs GROUP BY day ORDER BY day DESC LIMIT 14");
      return { per_agent, per_day };
    }
    throw Object.assign(new Error("not found"), { status: 404 });
  }

  const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf" };
  // Same-origin UI for `pnpm start`. The token is injected into index.html, so only serve it to loopback Host headers
  // (blocks DNS-rebinding pages from reading it).
  function serveUi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") return void res.writeHead(403).end("forbidden host");
    const root = path.resolve(o.uiDir!);
    let file = path.resolve(root, "." + decodeURIComponent(pathname));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, "index.html");
    if (!existsSync(file)) return void res.writeHead(404).end("UI not built. Run: pnpm start");
    let data: Buffer | string = readFileSync(file);
    if (file.endsWith("index.html")) data = data.toString("utf8").replace("</head>", `<script>window.__SF__=${JSON.stringify({ token: o.token })};</script></head>`);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600" }).end(data);
  }

  const api = http.createServer(async (req, res) => {
    const origin = req.headers.origin ?? "";
    if (ALLOWED_ORIGINS.has(origin)) res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/ping") return void res.writeHead(200).end("ok");
    if (o.uiDir && req.method === "GET" && !url.pathname.startsWith("/api/") && url.pathname !== "/ws") return serveUi(req, res, url.pathname);
    if (req.headers.authorization !== `Bearer ${o.token}` && url.searchParams.get("token") !== o.token) return void res.writeHead(401).end("unauthorized");
    // IDE routes expose file contents: loopback Host only (defence against DNS rebinding), on top of the token.
    if ((url.pathname.startsWith("/api/ws") || url.pathname.startsWith("/api/term")) && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return void res.writeHead(403).end("forbidden host");
    try {
      const out = await route(req.method ?? "GET", url, req.method === "GET" || req.method === "DELETE" ? {} : await body(req));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e), ...(e as { extra?: object }).extra }));
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  const termWss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const loopbackHost = (h: string | undefined) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h ?? "");
  api.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.searchParams.get("token") !== o.token) return socket.destroy();
    if (url.pathname === "/ws") return wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    if (url.pathname !== "/term") return socket.destroy();
    // A shell is full code execution: loopback Host (DNS rebinding) and a known Origin (cross-site pages), on top of the token.
    const origin = req.headers.origin;
    const port = (api.address() as { port: number }).port;
    const originOk = !origin || ALLOWED_ORIGINS.has(origin) || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
    const session = url.searchParams.get("session") ?? "";
    if (!loopbackHost(req.headers.host) || !originOk || !terms.get(session)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    termWss.handleUpgrade(req, socket, head, (ws) => {
      const detach = terms.attach(session, { send: (d) => ws.readyState === 1 && ws.send(d) });
      ws.on("message", (d, isBinary) => terms.input(session, Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer), isBinary));
      ws.on("close", detach);
    });
  });
  // Activity board: re-derive and push (debounced) whenever runs, agents or tasks may have changed.
  let actTimer: NodeJS.Timeout | null = null;
  hub.on("event", (e) => {
    const msg = JSON.stringify(e);
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    if ((e.type === "agents" || e.type === "tasks" || e.type === "log") && !actTimer)
      actTimer = setTimeout(() => {
        actTimer = null;
        hub.emitEvent({ type: "activity", ...activity(db) });
      }, 500);
  });

  // Agent-facing server: MCP + hooks, authenticated by the unguessable per-run id.
  const agent = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const [kind, runId] = url.pathname.split("/").filter(Boolean);
    if (!runId || !engine.active.has(runId)) return void res.writeHead(404).end("unknown run");
    if (req.method === "DELETE") return void res.writeHead(200).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    try {
      const b = await body(req);
      if (kind === "hook") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(engine.hook(runId, b)));
      if (kind === "mcp") {
        const out = Array.isArray(b) ? (await Promise.all(b.map((r) => handleMcp(engine, runId, r)))).filter(Boolean) : await handleMcp(engine, runId, b as never);
        if (out === null || (Array.isArray(out) && !out.length)) return void res.writeHead(202).end();
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(400).end(String(e));
    }
  });

  return new Promise((resolve, reject) => {
    api.once("error", reject);
    api.listen(o.apiPort, "127.0.0.1", () => {
      agent.listen(o.agentPort, o.agentBind, () => {
        const ap = (api.address() as { port: number }).port;
        const gp = (agent.address() as { port: number }).port;
        resolve({ apiPort: ap, agentPort: gp, close: () => { if (actTimer) clearTimeout(actTimer); terms.killAll(); api.close(); agent.close(); wss.close(); termWss.close(); } });
      });
    });
  });
}
