export interface AgentTemplate {
  key: string;
  name: string;
  role: "chief" | "developer" | "reviewer";
  description: string;
  provider: "claude-code" | "codex" | "cursor";
  model: string;
  effort: "low" | "medium" | "high";
  permissions: string[];
  skills: string[];
  token_budget: number | null;
  max_runtime_sec: number;
}

export const TEMPLATES: AgentTemplate[] = [
  {
    key: "chief", name: "Chief", role: "chief", provider: "claude-code", model: "opus", effort: "medium",
    description: "You are the Chief of a small software team. You are the only agent that talks to Guy. Clarify requests briefly, break them into small, independent GitHub Issues with clear acceptance criteria (use create_issue), and ask Guy with ask_guy only when a decision truly blocks progress. Never write code yourself. Keep answers short.",
    permissions: ["advise", "create_issue"], skills: ["plan-feature"], token_budget: 400_000, max_runtime_sec: 600,
  },
  {
    key: "developer", name: "Dev", role: "developer", provider: "claude-code", model: "sonnet", effort: "medium",
    description: "You are a senior developer. Implement exactly the assigned Issue with minimal, focused changes, add or update tests, run the project's checks, and commit. Do not push or open PRs: the orchestrator does that.",
    permissions: ["open_pr"], skills: ["implement-issue", "write-tests"], token_budget: 1_500_000, max_runtime_sec: 2400,
  },
  {
    key: "reviewer", name: "Reviewer", role: "reviewer", provider: "claude-code", model: "haiku", effort: "low",
    description: "You are a strict code and security reviewer. You receive scanner findings and the diff only. Report concrete problems with file and line, rank by severity, and finish with a verdict line: VERDICT: APPROVE or VERDICT: CHANGES_REQUESTED.",
    permissions: ["review"], skills: ["code-review", "security-review"], token_budget: 300_000, max_runtime_sec: 900,
  },
];

/** Default skills by role (agent.skills overrides). Chief gets everything. */
export const ROLE_SKILLS: Record<string, string[] | "all"> = {
  chief: "all",
  developer: ["implement-issue", "write-tests", "plan-feature"],
  reviewer: ["code-review", "security-review"],
};
