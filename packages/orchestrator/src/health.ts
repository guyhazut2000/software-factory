import { run, which, isWin } from "./util.js";
import { getToken } from "./github.js";

export interface Check {
  id: string;
  label: string;
  status: "ok" | "warn" | "missing";
  detail: string;
  required: boolean;
  /** Commands per OS to install / log in. */
  install?: Record<"win" | "mac" | "linux", string>;
  login?: string;
}

const same = (s: string) => ({ win: s, mac: s, linux: s });

async function version(cmd: string, args = ["--version"]): Promise<string | null> {
  if (!which(cmd)) return null;
  const r = await run(cmd, args, { timeoutMs: 15_000 });
  return r.code === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : null;
}

export async function healthChecks(): Promise<Check[]> {
  const out: Check[] = [];
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 22;
  out.push({ id: "node", label: "Node.js (bundled)", status: nodeOk ? "ok" : "warn", detail: `v${process.versions.node}`, required: true, install: same("https://nodejs.org/en/download") });

  const git = await version("git");
  out.push({
    id: "git", label: "Git", status: git ? "ok" : "missing", detail: git ?? "not found", required: true,
    install: { win: "winget install --id Git.Git -e", mac: "xcode-select --install", linux: "sudo apt install git   # or your package manager" },
  });

  const ghv = await version("gh");
  out.push({
    id: "gh", label: "GitHub CLI (optional if you use a token)", status: ghv ? "ok" : "warn", detail: ghv ?? "not found", required: false,
    install: { win: "winget install --id GitHub.cli -e", mac: "brew install gh", linux: "https://github.com/cli/cli/blob/trunk/docs/install_linux.md" },
  });
  const tok = await getToken();
  out.push({ id: "github", label: "GitHub connection", status: tok ? "ok" : "missing", detail: tok ? `token from ${tok.source}` : "not connected", required: true, login: "gh auth login   # or paste a token in the Projects tab" });

  const sbx = await version("sbx");
  out.push({
    id: "sbx", label: "Docker Sandboxes (sbx)", status: sbx ? "ok" : "warn", detail: sbx ?? "not found: use the worktree fallback in Settings (unsafe)", required: false,
    install: { win: "winget install -h Docker.sbx", mac: "brew install docker/tap/sbx", linux: "https://docs.docker.com/ai/sandboxes/get-started/  (install the sbx CLI)" },
    login: "sbx login",
  });
  if (sbx) {
    const ls = await run("sbx", ["ls"], { timeoutMs: 20_000 });
    out.push({ id: "sbx-login", label: "sbx signed in", status: ls.code === 0 ? "ok" : "missing", detail: ls.code === 0 ? "ok" : (ls.stderr || ls.stdout).trim().slice(0, 160), required: false, login: "sbx login" });
    const pol = await run("sbx", ["policy", "ls"], { timeoutMs: 20_000 });
    out.push({ id: "sbx-policy", label: "sbx network policy", status: pol.code === 0 && pol.stdout.trim() ? "ok" : "warn", detail: pol.code === 0 ? "policy configured" : "not initialized", required: false, login: "sbx policy init balanced" });
    out.push({ id: "sbx-github", label: "sbx GitHub secret", status: "warn", detail: "cannot be detected: run the command once", required: false, login: "sbx secret set github --command 'gh auth token'" });
  }

  for (const [id, label, names, installCmd, login] of [
    ["claude", "Claude Code CLI", ["claude"], same("npm install -g @anthropic-ai/claude-code"), "claude auth login"],
    ["codex", "Codex CLI", ["codex"], same("npm install -g @openai/codex"), "codex login"],
    ["cursor-agent", "Cursor Agent CLI", ["cursor-agent", "agent"], { win: "irm 'https://cursor.com/install?win32=true' | iex", mac: "curl https://cursor.com/install -fsS | bash", linux: "curl https://cursor.com/install -fsS | bash" }, "cursor-agent login"],
  ] as const) {
    const name = names.find((n) => which(n));
    const v = name ? await version(name) : null;
    out.push({ id, label, status: v ? "ok" : "warn", detail: v ?? "not found (needed only if an agent uses it)", required: false, install: installCmd as Check["install"], login });
  }
  void isWin;
  return out;
}
