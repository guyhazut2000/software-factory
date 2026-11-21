import { run } from "./util.js";

let pat: string | null = null;
let cached: { token: string; at: number } | null = null;

export function setToken(t: string | null): void {
  pat = t?.trim() || null;
  cached = null;
}

export async function getToken(): Promise<{ token: string; source: "pat" | "env" | "gh" } | null> {
  if (pat) return { token: pat, source: "pat" };
  const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (env) return { token: env, source: "env" };
  if (cached && Date.now() - cached.at < 60_000) return { token: cached.token, source: "gh" };
  const r = await run("gh", ["auth", "token"], { timeoutMs: 10_000 });
  if (r.code === 0 && r.stdout.trim()) {
    cached = { token: r.stdout.trim(), at: Date.now() };
    return { token: cached.token, source: "gh" };
  }
  return null;
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const t = await getToken();
  if (!t) throw new Error("GitHub is not connected. Run `gh auth login` or paste a token in Projects.");
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${t.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "software-factory" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface Repo {
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  pushed_at: string;
}

export const gh = {
  user: () => api<{ login: string; name: string | null }>("/user"),
  async listRepos(): Promise<Repo[]> {
    const out: Repo[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = await api<Repo[]>(`/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`);
      out.push(...r);
      if (r.length < 100) break;
    }
    return out;
  },
  getRepo: (repo: string) => api<Repo>(`/repos/${repo}`),
  createRepo: (name: string, isPrivate: boolean, description = "") => api<Repo>("/user/repos", { method: "POST", body: { name, private: isPrivate, description, auto_init: true } }),
  async ensureLabel(repo: string, name: string, color: string, description = ""): Promise<void> {
    try {
      await api(`/repos/${repo}/labels`, { method: "POST", body: { name, color, description } });
    } catch (e) {
      if (!String(e).includes("422")) throw e; // already exists
    }
  },
  createIssue: (repo: string, title: string, body: string, labels: string[]) => api<{ number: number; html_url: string }>(`/repos/${repo}/issues`, { method: "POST", body: { title, body, labels } }),
  listIssues: (repo: string, label: string) => api<{ number: number; title: string; body: string | null; labels: { name: string }[]; pull_request?: unknown }[]>(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=50`),
  addLabels: (repo: string, n: number, labels: string[]) => api(`/repos/${repo}/issues/${n}/labels`, { method: "POST", body: { labels } }),
  async removeLabel(repo: string, n: number, label: string): Promise<void> {
    try {
      await api(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
    } catch {
      /* label not present */
    }
  },
  comment: (repo: string, n: number, body: string) => api(`/repos/${repo}/issues/${n}/comments`, { method: "POST", body: { body } }),
  closeIssue: (repo: string, n: number) => api(`/repos/${repo}/issues/${n}`, { method: "PATCH", body: { state: "closed" } }),
  createPr: (repo: string, head: string, base: string, title: string, body: string) => api<{ number: number; html_url: string }>(`/repos/${repo}/pulls`, { method: "POST", body: { head, base, title, body } }),
  findPr: async (repo: string, owner: string, head: string) => (await api<{ number: number; html_url: string }[]>(`/repos/${repo}/pulls?head=${owner}:${encodeURIComponent(head)}&state=open`))[0],
  prStatus: async (repo: string, n: number) => {
    const pr = await api<{ merged: boolean; state: string; head: { sha: string }; mergeable_state: string }>(`/repos/${repo}/pulls/${n}`);
    const checks = await api<{ check_runs: { conclusion: string | null; status: string }[] }>(`/repos/${repo}/commits/${pr.head.sha}/check-runs`).catch(() => ({ check_runs: [] }));
    const total = checks.check_runs.length;
    const failed = checks.check_runs.filter((c) => c.conclusion && !["success", "skipped", "neutral"].includes(c.conclusion)).length;
    const pending = checks.check_runs.filter((c) => c.status !== "completed").length;
    return { merged: pr.merged, state: pr.state, mergeable_state: pr.mergeable_state, ci: total === 0 ? "none" : failed ? "failing" : pending ? "pending" : "passing" };
  },
  mergePr: (repo: string, n: number) => api(`/repos/${repo}/pulls/${n}/merge`, { method: "PUT", body: { merge_method: "squash" } }),
};

export const STATUS_LABELS: [string, string][] = [
  ["status:backlog", "ededed"],
  ["status:ready", "0e8a16"],
  ["status:working", "fbca04"],
  ["status:blocked", "d93f0b"],
  ["status:review", "1d76db"],
  ["status:done", "5319e7"],
];

export async function bootstrapLabels(repo: string, agentNames: string[]): Promise<void> {
  for (const [n, c] of STATUS_LABELS) await gh.ensureLabel(repo, n, c, "Software Factory status");
  for (const a of agentNames) await gh.ensureLabel(repo, `agent:${a}`, "c5def5", "Assign to this agent");
}
