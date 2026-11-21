# Software Factory

A local desktop app that runs a team of AI coding agents (Claude Code, Codex, Cursor) in isolated Docker Sandboxes (`sbx`) on your own machine, driven by GitHub Issues and PRs. No cloud services. See [docs/DESIGN.md](docs/DESIGN.md).

Status: phase 1 skeleton (schema, adapter interface, state machine, scheduler). Roadmap lives in GitHub Issues.

## Layout
- `apps/desktop` – Tauri + React dashboard (placeholder until phase 4)
- `packages/orchestrator` – Node/TypeScript orchestrator (state machine, scheduler, later supervisor)
- `packages/db` – Drizzle SQLite schema
- `packages/adapters` – provider adapter interface + Claude Code adapter (stub)
- `docs/` – design doc and ADRs

## Setup on your machine
1. Node 22+ and pnpm 10: `corepack enable && corepack prepare pnpm@10 --activate`
2. Git and GitHub CLI: `gh auth login` (scopes: `repo`, `workflow`)
3. Docker Sandboxes CLI: install `sbx` per https://docs.docker.com/ai/sandboxes/get-started/ then `sbx login` (free Docker account; Docker Desktop not required). Needs virtualization enabled; ~4 GB RAM per running agent.
4. GitHub access for agents: `sbx secret set github` (paste a fine-grained token limited to the project repos: Contents, Pull requests, Issues read/write).
5. Provider CLIs you plan to use: `claude` (Claude Code), `codex`, `cursor-agent`; log in to each (subscription or API key).
6. Clone and install: `git clone https://github.com/guyhazut2000/software-factory && cd software-factory && pnpm install`
7. Check: `pnpm typecheck && pnpm lint && pnpm test`

Rust is needed only from phase 4 (Tauri): https://tauri.app/start/prerequisites/
