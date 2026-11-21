/** Dangerous-action guard used by Claude Code PreToolUse hooks and tested standalone. */
const BASH_RULES: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\*)(\s|$)/i, "recursive delete of root/home"],
  [/\bsudo\b/, "sudo is not allowed"],
  [/\bgit\s+push\b[^\n]*(--force|-f\b|--force-with-lease)/, "force push is not allowed"],
  [/\bgit\s+push\b[^\n]*\b(origin\s+)?(main|master)\b/, "pushing to main/master is not allowed"],
  [/\bgit\s+push\b[^\n]*\bHEAD:(main|master)\b/, "pushing to main/master is not allowed"],
  [/(curl|wget)[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell)\b/i, "piping downloads into a shell"],
  [/\b(mkfs|fdisk|diskpart|format\s+[a-z]:)/i, "disk formatting"],
  [/\bdd\s+if=/, "raw disk write"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/(~|\$HOME|%USERPROFILE%)[\\/]\.(ssh|aws|gnupg|config[\\/]gh)/i, "access to credentials"],
  [/\b(printenv|env)\b\s*($|\|)/, "dumping environment (may leak secrets)"],
  [/\bgh\s+auth\s+(token|status\s+-t)/, "reading GitHub token"],
  [/\bchmod\s+-R\s+777\s+\//, "unsafe chmod on root"],
];

const PATH_RULES: [RegExp, string][] = [
  [/(^|[\\/])\.git[\\/](?!info)/, "editing .git internals"],
  [/(^|[\\/])\.sf[\\/]/, "editing orchestrator files"],
  [/(^|[\\/])\.ssh[\\/]|id_rsa|id_ed25519/, "access to SSH keys"],
  [/(^|[\\/])\.env($|\.)/, "editing env files with secrets"],
];

export interface GuardResult {
  block: boolean;
  reason?: string;
}

export function checkToolUse(tool: string, input: Record<string, unknown> | undefined): GuardResult {
  const i = input ?? {};
  if (tool === "Bash" || tool === "shell" || tool === "PowerShell") {
    const cmd = String(i.command ?? "");
    for (const [re, reason] of BASH_RULES) if (re.test(cmd)) return { block: true, reason };
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const p = String(i.file_path ?? i.notebook_path ?? "");
    for (const [re, reason] of PATH_RULES) if (re.test(p)) return { block: true, reason };
  }
  return { block: false };
}
