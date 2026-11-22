# Software Factory

A local desktop app that runs a team of AI coding agents (Claude Code, Codex, Cursor Agent) on your own computer, each in an isolated Docker Sandbox (`sbx`), driven by GitHub Issues and PRs. No cloud services, free apart from your model subscriptions.

Design: [docs/DESIGN.md](docs/DESIGN.md). Roadmap and open work: GitHub Issues.

## Run from source (any OS, cmd/PowerShell/bash)

```
git clone https://github.com/guyhazut2000/software-factory
cd software-factory
pnpm install
pnpm start
```

`pnpm start` builds what is missing, starts the orchestrator on `http://127.0.0.1:47821`, and opens it in your browser. The orchestrator is the local background service that runs the agents (it drives git, `sbx` and the provider CLIs), and it serves the UI itself, so there is nothing else to start. A random access token is generated and injected automatically: never set `SF_API_TOKEN` by hand. Ctrl+C stops everything. Needs Node 22.13+ and `git`. Change the port with `SF_PORT` (cmd: `set SF_PORT=47900& pnpm start`, no space before `&`). For UI development with hot reload use `pnpm dev`.

## Installer quickstart

1. **Download** the installer for your OS from the [latest release](https://github.com/guyhazut2000/software-factory/releases/latest) (the repo is private: you must be signed in to GitHub).
   | OS | File |
   |---|---|
   | Windows | `Software.Factory_*_x64-setup.exe` (or the `.msi`) |
   | macOS Apple Silicon | `Software.Factory_*_aarch64.dmg` |
   | macOS Intel | `Software.Factory_*_x64.dmg` |
   | Linux | `.AppImage` (`chmod +x`, run) or `.deb` (`sudo apt install ./file.deb`) |
2. **Open it past the unsigned-app warning** (builds are unsigned):
   - **Windows SmartScreen:** "Windows protected your PC" -> *More info* -> *Run anyway*.
   - **macOS Gatekeeper:** open the app once (it is blocked), then *System Settings -> Privacy & Security -> Open Anyway*. Or in a terminal: `xattr -dr com.apple.quarantine "/Applications/Software Factory.app"`.
   - **Linux:** nothing needed for AppImage/deb.
3. The app starts its own orchestrator (a bundled Node.js, nothing to install). Open the **Setup** tab: it shows what is installed and gives copy-paste install/login commands for your OS, with a Re-check button.
4. **Connect GitHub** (Projects tab): run `gh auth login` in a terminal (auto-detected), or paste a Personal Access Token (stored in your OS keychain).
5. **Install what you use** (Setup tab shows exact commands):
   - `git` (required).
   - Docker Sandboxes: Windows `winget install -h Docker.sbx`, macOS `brew install docker/tap/sbx`, Linux per [Docker docs](https://docs.docker.com/ai/sandboxes/get-started/). Then `sbx login`, then in the Setup tab press **Apply default policy**, and run `sbx secret set github --command "gh auth token"` once.
   - At least one provider CLI and log in: `claude auth login`, `codex login`, or `cursor-agent login`.
6. **Agents tab:** add the **Chief**, **Dev** and **Reviewer** templates and switch them on (check provider/model on each).
7. **Projects tab:** link an existing repo (or create one). Labels `status:*` and `agent:*` are created for you.
8. **Chief tab:** describe a feature. The Chief creates Issues, a Dev picks one up in a sandbox, opens a PR, the Reviewer reviews it (scanners first), and you press **Merge** on the Dashboard.

No `sbx` at work yet? Settings -> Runner -> "Git worktree" and accept the warning: agents then run directly on your machine (no isolation, guarded only by hooks). Good for a first test, not for unattended use.

## How it works

- The desktop app (Tauri + React) starts a local **orchestrator** (Node.js, bundled as a sidecar) on random localhost ports with a random API token. The UI talks to it over HTTP + WebSocket.
- Data lives in `~/.software-factory` (SQLite `factory.db`, repo clones, logs). The app log is `orchestrator.log` in the OS app-log folder.
- Every task is a GitHub Issue (`status:ready`). Work = branch `sf/<issue>-<slug>` + PR. Merge is always your click.
- Agents get a `factory` MCP server (get_task_context, report_progress, ask_guy, request_restart, send_message, create_issue for Chief), Claude Code hooks (PreToolUse blocks dangerous commands, PostToolUse/Stop send heartbeats), git hooks (block pushes to main), and skills from `skills/`.

## Development

```
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @sf/orchestrator build       # bundle the orchestrator
# browser dev (no Tauri): run the orchestrator and Vite
SF_API_TOKEN=dev node packages/orchestrator/dist/orchestrator.mjs &
pnpm --filter @sf/desktop dev              # http://localhost:1420/?token=dev
# desktop dev / installers (needs Rust + platform deps: https://tauri.app/start/prerequisites/)
node apps/desktop/scripts/fetch-node.mjs   # downloads the sidecar Node for your platform
pnpm --filter @sf/desktop tauri dev
```

Release: push a tag `vX.Y.Z`; the `Release` workflow builds Windows (nsis + msi), macOS (arm64 + x64 dmg) and Linux (AppImage + deb) installers and publishes the GitHub Release.

## Troubleshooting

- **"Token mismatch" or "HTTP 401" in the UI:** an old orchestrator is still running, or `SF_API_TOKEN` was set by hand (in cmd, `set A=b && cmd` stores `b ` with a trailing space). Close all node processes for Software Factory (Task Manager, or `taskkill /im node.exe /f`), unset `SF_API_TOKEN`, run `pnpm start`.
- **"Port 47821 is already in use":** a previous run is still alive; close it or set `SF_PORT`.
- **"Node ... is too old":** install Node 22.13 or newer (nodejs.org, or `nvm install 22`).
- **Browser did not open:** open the URL printed in the terminal; set `SF_NO_OPEN=1` to never auto-open.

- **App shows "Starting the orchestrator..." forever:** check `orchestrator.log` (macOS `~/Library/Logs/dev.guyhazut.softwarefactory/`, Linux `~/.local/share/dev.guyhazut.softwarefactory/logs/`, Windows `%LOCALAPPDATA%\dev.guyhazut.softwarefactory\logs`). Security software can block the local port or the bundled `sf-node`; allow it.
- **Windows "VCRUNTIME"/WebView2 error:** install the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
- **Linux AppImage does not start:** install `libfuse2`, or use the `.deb`.
- **Keychain error on Linux:** needs a Secret Service (gnome-keyring/KWallet) running; otherwise rely on `gh auth login`.
- **Agent says "X CLI not installed" but it is:** the app reads your login-shell PATH on macOS/Linux; restart the app after installing CLIs. On Windows, reopen the app so it sees the new PATH.
- **Agents in sbx cannot reach factory tools (no progress/questions):** Settings -> "Host name inside sandboxes" (default `host.docker.internal`); the sandbox network policy must allow it. This path is unverified on a real sbx install; use the worktree fallback to confirm the rest works.
- **Task fails with "No changes made":** the agent finished without committing; open the task Log on the Dashboard.
- **GitHub 403/404:** the token needs `repo` + `workflow` scopes (classic) or Contents/Pull requests/Issues (fine-grained) on that repo.
