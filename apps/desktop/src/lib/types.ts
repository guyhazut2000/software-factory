export interface Agent {
  id: string; name: string; role: string; description: string; provider: string; model: string; effort: string;
  context: { files?: string[]; allowed_paths?: string[]; history_size?: number };
  permissions: string[]; token_budget: number | null; max_runtime_sec: number; cpu: number; ram_mb: number;
  skills: string[]; mcp: { github?: boolean; filesystem?: boolean };
  enabled: boolean; state: string; current_task_id: string | null; tokens_today: number; usd_today: number;
}
export interface Project { id: string; name: string; kind: "github" | "folder" | "none"; repo: string | null; root_path: string | null; default_branch: string; instructions: string }
export const projectLabel = (p: Pick<Project, "repo" | "name">) => p.repo ?? p.name;
export interface Task {
  id: string; project_id: string; issue_number: number | null; title: string; body: string; status: string;
  assignee_id: string | null; branch: string | null; pr_number: number | null; pr_url: string | null; summary: string; note: string;
  restart_count: number; running: boolean; updated_at: number;
}
export interface Question { id: string; task_id: string | null; agent_id: string; project_id: string | null; body: string; asked_at: number }
export interface Settings {
  mode: "quiet" | "eco" | "full"; cap: number; runner: "sbx" | "worktree"; allow_worktree: boolean; stopped: boolean;
  agent_host: string; stuck_minutes: number; max_restarts: number; max_review_rounds: number;
}
export interface Template { key: string; name: string; role: string; description: string; provider: string; model: string; effort: string; permissions: string[]; skills: string[]; token_budget: number | null; max_runtime_sec: number }
export interface State {
  agents: Agent[]; projects: Project[]; tasks: Task[]; reviews: { id: string; title: string; status: string; note: string }[];
  questions: Question[]; settings: Settings; running: { run_id: string; agent_id: string; task_id: string | null; started_at: number; tokens: number }[]; templates: Template[];
}
export interface LogEvent { run_id: string; task_id: string | null; agent_id: string; kind: string; text: string; ts: number }
export interface Check { id: string; label: string; status: "ok" | "warn" | "missing"; detail: string; required: boolean; install?: Record<"win" | "mac" | "linux", string>; login?: string }
export interface Message { id: string; from_id: string | null; body: string; created_at: number; to_id: string | null }
