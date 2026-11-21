import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const projects = sqliteTable("projects", {
  id: id(),
  name: text("name").notNull(),
  repo: text("repo").notNull(), // owner/name
  defaultBranch: text("default_branch").notNull().default("main"),
  createdAt: ts("created_at").notNull(),
});

export const agents = sqliteTable("agents", {
  id: id(),
  name: text("name").notNull(),
  role: text("role").notNull(), // chief | developer | reviewer | security | custom
  description: text("description").notNull().default(""), // system prompt
  provider: text("provider").notNull(), // claude-code | codex | cursor
  model: text("model").notNull(),
  effort: text("effort").notNull().default("medium"),
  contextJson: text("context_json").notNull().default("{}"), // instruction files, allowed paths, history size
  permissions: text("permissions").notNull().default("advise"), // advise | open_pr | review | merge (csv)
  dailyTokenBudget: integer("daily_token_budget"),
  maxRuntimeSec: integer("max_runtime_sec").notNull().default(1800),
  sandboxCpu: integer("sandbox_cpu").notNull().default(2),
  sandboxRamMb: integer("sandbox_ram_mb").notNull().default(4096),
  skills: text("skills").notNull().default(""), // csv tags
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  state: text("state").notNull().default("off"), // off|idle|working|waiting_for_guy|stuck|restarting
});

export const tasks = sqliteTable("tasks", {
  id: id(),
  projectId: text("project_id").notNull().references(() => projects.id),
  issueNumber: integer("issue_number"),
  title: text("title").notNull(),
  status: text("status").notNull().default("queued"), // queued|assigned|working|waiting_for_guy|in_review|done|failed
  assigneeId: text("assignee_id").references(() => agents.id),
  branch: text("branch"),
  prNumber: integer("pr_number"),
  summary: text("summary").notNull().default(""), // checkpoint summary for restarts
  restartCount: integer("restart_count").notNull().default(0),
  createdAt: ts("created_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: id(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  sandboxName: text("sandbox_name"),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
  exitReason: text("exit_reason"), // ok|error|timeout|stuck|budget|stopped
  lastHeartbeatAt: ts("last_heartbeat_at"),
});

export const messages = sqliteTable("messages", {
  id: id(),
  taskId: text("task_id").references(() => tasks.id),
  fromAgentId: text("from_agent_id"), // null = Guy
  toAgentId: text("to_agent_id"), // null = Guy
  body: text("body").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const questions = sqliteTable("questions", {
  id: id(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  body: text("body").notNull(),
  answer: text("answer"),
  askedAt: ts("asked_at").notNull(),
  answeredAt: ts("answered_at"),
});

export const costs = sqliteTable("costs", {
  id: id(),
  runId: text("run_id").notNull().references(() => runs.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  usd: real("usd").notNull().default(0),
  createdAt: ts("created_at").notNull(),
});
