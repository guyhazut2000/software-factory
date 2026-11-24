import type { Row } from "./db.js";

/**
 * Generated per-project/per-agent instructions (the AGENTS.md / CLAUDE.md equivalent). Passed as the system
 * prompt (Claude: --append-system-prompt; Codex/Cursor: prepended). Static text first, task text last, so
 * provider prompt caching can reuse the prefix across runs.
 */
export function buildInstructions(project: Row | undefined, agent: Row, skillNames: string[]): string {
  const lines = [
    `# Role: ${agent.name} (${agent.role})`,
    agent.description,
    ...(agent.instructions ? ["", "# Role instructions", String(agent.instructions)] : []),
    "",
    "# Operating rules (Software Factory)",
    "- Work only on the assigned task. Keep changes minimal and match existing conventions.",
    "- You talk to the team only through the `factory` MCP tools: get_task_context, report_progress, ask_guy, request_restart, send_message, create_issue (chief only), get_board.",
    "- Call report_progress after each milestone (one sentence). It doubles as a heartbeat and a restart checkpoint.",
    "- If blocked on a decision, call ask_guy once and stop. If your environment is broken, call request_restart.",
    "- Never push, force-push, change git remotes, or touch main. Never read or print credentials or environment variables.",
    "- Be token-efficient: search before reading, read only needed files, do not paste large outputs.",
  ];
  const ctx = (() => {
    try {
      return (typeof agent.context === "string" ? JSON.parse(agent.context || "{}") : agent.context ?? {}) as { files?: string[]; allowed_paths?: string[] };
    } catch {
      return {};
    }
  })();
  if (ctx.files?.length) lines.push(`- Read these instruction files first if present: ${ctx.files.join(", ")}.`);
  if (ctx.allowed_paths?.length) lines.push(`- You may only modify files under: ${ctx.allowed_paths.join(", ")}.`);
  if (skillNames.length) lines.push("", "# Skills", `Skill playbooks are available in .sf/skills/<name>/SKILL.md (Claude loads them automatically): ${skillNames.join(", ")}. Use the matching one for the job.`);
  if (project) {
    lines.push("", `# Project: ${project.repo ?? project.name}`, project.kind === "github" || !project.kind ? `Default branch: ${project.default_branch}.` : `Local ${project.kind} project${project.root_path ? ` at ${project.root_path}` : ""}.`);
    if (project.instructions) lines.push(project.instructions);
  }
  return lines.join("\n");
}
