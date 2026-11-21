/** Minimal MCP server (streamable HTTP, JSON responses) exposing the "factory" tools to agents. */
export interface FactoryHost {
  getTaskContext(runId: string): Promise<unknown>;
  reportProgress(runId: string, summary: string, percent?: number): Promise<string>;
  createIssue(runId: string, a: { title: string; body: string; labels?: string[]; agent?: string; project_id?: string }): Promise<string>;
  askGuy(runId: string, question: string): Promise<string>;
  requestRestart(runId: string, reason: string, summary?: string): Promise<string>;
  sendMessage(runId: string, to: string, body: string): Promise<string>;
  board(runId: string): Promise<unknown>;
}

const str = { type: "string" };
export const TOOLS = [
  { name: "get_task_context", description: "Get your current task: issue title/body, previous progress summary, Guy's answers, restart count.", inputSchema: { type: "object", properties: {} } },
  { name: "report_progress", description: "Report a short progress note (also a heartbeat and a restart checkpoint). Call after each milestone.", inputSchema: { type: "object", properties: { summary: str, percent: { type: "number" } }, required: ["summary"] } },
  { name: "create_issue", description: "Chief only: create a GitHub Issue that becomes a task. Optional agent name pins an agent.", inputSchema: { type: "object", properties: { title: str, body: str, labels: { type: "array", items: str }, agent: str, project_id: str }, required: ["title", "body"] } },
  { name: "ask_guy", description: "Ask Guy a blocking question. The task pauses (waiting_for_guy) and you will be resumed with the answer. After calling this, stop working.", inputSchema: { type: "object", properties: { question: str }, required: ["question"] } },
  { name: "request_restart", description: "Request a full sandbox restart from a checkpoint (use if the environment is broken). Include a summary of progress so far.", inputSchema: { type: "object", properties: { reason: str, summary: str }, required: ["reason"] } },
  { name: "send_message", description: "Send a message to another agent (by name, or 'chief') through the orchestrator bus. Logged and visible to Guy.", inputSchema: { type: "object", properties: { to: str, body: str }, required: ["to", "body"] } },
  { name: "get_board", description: "List agents and tasks with their status.", inputSchema: { type: "object", properties: {} } },
];

type Req = { jsonrpc: "2.0"; id?: number | string; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

export async function handleMcp(host: FactoryHost, runId: string, req: Req): Promise<object | null> {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "initialize":
      return ok({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "factory", version: "0.1.0" } });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = req.params?.name ?? "";
      const a = (req.params?.arguments ?? {}) as Record<string, string & string[] & number>;
      try {
        let text: unknown;
        if (name === "get_task_context") text = await host.getTaskContext(runId);
        else if (name === "report_progress") text = await host.reportProgress(runId, String(a.summary), a.percent);
        else if (name === "create_issue") text = await host.createIssue(runId, { title: String(a.title), body: String(a.body), labels: a.labels, agent: a.agent, project_id: a.project_id });
        else if (name === "ask_guy") text = await host.askGuy(runId, String(a.question));
        else if (name === "request_restart") text = await host.requestRestart(runId, String(a.reason), a.summary);
        else if (name === "send_message") text = await host.sendMessage(runId, String(a.to), String(a.body));
        else if (name === "get_board") text = await host.board(runId);
        else return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: `Unknown tool ${name}` } };
        return ok({ content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }] });
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
      }
    }
    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}
