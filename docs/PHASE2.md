# Phase 2: a local personal work environment

Scope (from Guy): local-only, free. One place to manage his tasks and projects: git-backed work (GitHub Issues/PRs per linked repo) AND non-git work (scripts, automations, data jobs, misc tasks). Agents work per project in an organized way. Guy talks mainly to the Chief but can talk to any agent (inbox of pending asks, threads). He can browse each project's files, see diffs of agent work, and see who is doing what, live.

Revision 2: the product also doubles as an **IDE when needed** (edit files, see git diffs, commit, use terminals), and every agent gets its own settings and terminal, in the spirit of JSM HQ (section 0).

This document is the audit and design only. Nothing here is built yet.

## 0. Reference project: JSM HQ

Guy's "JS AdQuarters" is **JSM HQ** by JavaScript Mastery: https://github.com/jsmastery-pro/jsm-hq (MIT, npm `@therealjsmastery/jsm-hq`, announced via a DEV Community post, "We Gave Our AI Coding Agents an Office"). Confidence: high (name, author, local multi-agent coding tool in Docker Sandboxes). Guy's GitHub (guyhazut2000) has no fork or copy of it, so "my project" means the one he is going to build.

What it is: run inside a git repo with a GitHub remote, a lead agent plans and a team of Claude Code / Codex workers builds in isolated Docker Sandboxes, one task = one branch = one PR, shown as a pixel-art office in the browser at `127.0.0.1:7420`.
Stack: Node >= 20 server (TypeScript, `ws` WebSocket, MCP SDK), React + Vite + Tailwind 4 front end, canvas pixel-art office, **xterm.js in the browser + `@lydell/node-pty` on the server** (prebuilt binaries, no compiler needed; tmux keeps agents alive on macOS/Linux, plain PTY on Windows), `@xterm/headless` for terminal state, loopback-only HTTP with a browser token and per-agent tokens, an `hq` MCP server for agent messaging, Claude Code hooks, GitHub polling (about every 20 s) via `gh`.
Important finding: **it has no code editor and no diff UI** (no Monaco or CodeMirror). Review happens on GitHub. So the "edit files, see git diff, version control" part of Guy's idea is beyond HQ and is designed here from scratch.

Features we copy:
1. **Agent drawer**: click an agent to open a resizable panel with its live terminal, a shell inside its sandbox, its task, its messages and its settings (we add Files and Diff tabs).
2. **Terminal in the top bar**: Guy's own shell in the repo, any agent's folder or a chosen folder (xterm.js + node-pty, links clickable, copy/paste rules per OS).
3. **Per-agent settings and role file** (role text, model, sandbox CPU/RAM with "recreate sandbox").
4. **Action items**: one list of everything waiting on Guy (questions, keys, blocked websites) with exact steps, never secret values. Our inbox (M6) adopts this, including a "request network access" ask that becomes an `sbx policy allow` rule scoped to one sandbox.
5. **Rules that keep parallel agents sane**: the lead never writes code, one task = one branch = one PR, each task lists the files it may touch, agents ask instead of working around blocks, and HQ never merges.
Not copied: the pixel-art office (Guy asked for a clean work-method UI), tmux persistence (possible later), npm distribution.

Other candidates considered (rejected): `adrianhajdin/skild` (AI agent skills sharing site), `adrianhajdin/atelier-store` (agentic engineering demo store). Neither is an agent dashboard or IDE.

## 1. Audit of v0.1.0 against this scope

| Area | State | Notes |
|---|---|---|
| Orchestrator core (intake from `status:ready` issues, assign, run, branch, PR, review, merge button) | Works (scripted fake provider vs real GitHub) | Never run with a real model |
| Host worktree runner | Works (fake provider) | No isolation, explicit warning toggle |
| `sbx` runner | Written, unverified | #24 |
| Provider adapters (Claude, Codex, Cursor) | Command lines from docs; event parsing unverified | #25 |
| Factory MCP (progress, context, ask_guy, restart, send_message, create_issue, board) | Works over HTTP with the fake CLI | Real client behaviour unverified |
| Hooks (Claude `PreToolUse` guard, heartbeats, git pre-push/post-commit) | Written + unit tested guard | Codex/Cursor have none (#30) |
| Supervisor (stuck/loop/burn, escalation, restart limits) | Unit tested; wired | Not exercised on real runs |
| Chief chat, `ask_guy` pause/resume, questions inbox | Written, UI exists | Needs a real-model test (#26) |
| Dashboard, agents editor, projects, setup, settings, costs | Works | Dashboard is task-centric, git only |
| Run from source / installers | Works, CI on 3 OSes | Unsigned (#29) |
| DB | `node:sqlite`, create-if-not-exists only | No migrations (#27) |
| **Non-git tasks / local projects** | **Missing** | Projects require a GitHub repo; tasks require an Issue |
| **Scripts / automations / schedules** | **Missing** | |
| **Per-agent inbox and threads, direct chat with any agent** | **Partial** | One chat channel (Chief); asks are a flat list, no threads |
| **File viewer + diffs** | **Missing** | |
| **Live "who does what" board** | **Partial** | Agent cards show state/task/tokens; no branch, sandbox, history, per-project view |

### Old issues
#1-#3, #6-#8, #10-#16 are implemented by v0.1.0 (verification gaps are tracked in #24-#26 and #30-#31); #9 is implemented; #4 is superseded by ADR 4 and #27; #5 is covered by #25; #20 was a demo. They are closed with a pointer to this section. #24-#31 stay open and are scheduled below.

## 2. Design

### 2.1 Projects: GitHub repo, local folder, or none
`projects` gains `kind` (`github` | `folder` | `none`), `root_path` (the base clone for `github`, the user's directory for `folder`, null for `none`), and `repo` becomes nullable.
- `github`: as today. Issues are the task source of truth.
- `folder`: a directory on this machine (not necessarily a git repo). Agents/scripts run against it (in `sbx` as a direct workspace mount, or on host with the warning toggle). If the folder is a git repo, branch/diff features work locally without GitHub.
- `none`: a container for loose tasks and automations (e.g. "Personal", "Finance data").

### 2.2 Unified Task
One `tasks` table, one kanban. New/changed columns:

| Column | Meaning |
|---|---|
| `source` | `github` (backed by an Issue) or `local` |
| `type` | `code` (agent changes a repo, ends in a PR or a local diff), `script` (runs an automation), `manual` (a to-do for Guy), `review` (internal) |
| `project_id` | nullable for loose tasks |
| `external_ref` | Issue number for `github` tasks (today's `issue_number`) |
| `md_path` | path of the markdown mirror for `local` tasks |
| `priority`, `due_at`, `parent_id` | optional planning fields |
| `automation_id` | for `script` tasks |

Status machine is shared: `queued, working, waiting_for_guy, in_review, done, failed`. `manual` tasks go `queued -> done` by Guy. `code` tasks on a `folder` project end in `in_review` with a local diff to accept (merge into the folder's branch) instead of a PR.

### 2.3 Local tasks are versioned via git too
A local git repo, the **workspace repo**, at `~/.software-factory/workspace` (created on first use, `git init`, no remote by default, so it stays local and free). Layout:
```
workspace/
  tasks/<project-slug-or-_loose>/<id>-<slug>.md     # front matter: id, status, type, priority, due, labels, assignee; body = description
  automations/<name>.yaml                           # definition (see 2.4)
  notes/                                            # optional free notes
```
Rules: SQLite holds runtime state and is the working index; for `local` tasks the markdown file is the canonical content (title/body/status/labels). Writes go through the orchestrator, which updates SQLite and the file, and commits (debounced, message `task <id>: <change>`). On startup the orchestrator re-imports files whose mtime/hash changed, so Guy can edit tasks in his editor or git-pull them from another machine. Runtime-only data (runs, logs, costs, messages) stays only in SQLite. Optional later: add a private GitHub remote to the workspace repo (off by default).

### 2.4 Automations (scripts, data jobs)
Table `automations`: `id, project_id, name, description, kind ('command'|'agent'), command, args, cwd, runner ('sbx'|'host'), env_refs (names only, values from an OS-keychain-backed store), timeout_sec, trigger ('manual'|'schedule'|'file_change'|'git_push'), schedule (cron or interval), outputs_dir, enabled`. The YAML mirror lives in the workspace repo.
- `kind=command`: runs a script/command with no model, so zero tokens. `kind=agent`: runs an agent with a prompt (counts against the agent cap and budgets).
- Runner `sbx`: sandbox with the project folder mounted directly (read-write only where declared; `:ro` for the rest), network per the global policy. Runner `host`: same explicit-warning toggle as the worktree fallback.
- A run is a row in `runs` (`kind='script'`) with streamed `events` (stdout/stderr lines), exit code, duration. Declared outputs (`outputs_dir`) are indexed in `artifacts(run_id, path, size, sha256)` and viewable in the file viewer.
- Scheduling: an in-process timer loop (cron parser, no external service), missed runs while the app was closed are skipped by default (configurable: run once on start). Triggers `file_change`/`git_push` come later and are polling-based.
- Concurrency: the **agent cap (default 3) is unchanged** and still the token-saving limit. Scripts that call no model use a separate **script cap (default 2)** because they cost CPU/RAM, not tokens. Modes quiet/eco/full and stop-all apply to both.

### 2.5 Conversations and the inbox
- `threads(id, agent_id, project_id, task_id?, title, kind, status, created_at)`; `kind`: `chief` (the main channel), `direct` (Guy talks to a specific agent), `ask` (opened by an agent that needs something).
- `messages` gains `thread_id`; existing chat messages migrate into a `chief` thread per project.
- `asks` generalise `questions`: `kind` (`question` | `approval` | `action` (a manual step for Guy, e.g. "please log in to X") | `credential`), optional `options` (buttons), `thread_id`, `task_id`, `status` (`open|answered|dismissed`). The existing `ask_guy` MCP tool gets optional `kind` and `options` parameters; behaviour (pause the task into `waiting_for_guy`, desktop notification, resume with the answer) is unchanged.
- **Inbox view:** open asks grouped by agent with counts, plus the thread list; answering an ask posts into its thread.
- **Direct chat:** sending a message in a `direct` thread to an idle agent runs a one-shot turn with that agent's profile (same mechanism as the Chief chat), read-only by default. Anything that changes files must go through a task, so work stays attributable and reviewable. If the agent is busy, the message is queued as a note delivered at its next turn (`get_task_context` returns pending notes).
- Agents still only talk to each other through the orchestrator bus (`send_message`), now visible inside threads.

### 2.6 IDE workspace per project (browse, edit, git)
One **IDE tab** per project: file tree (left), tabbed **Monaco** editor (center), git panel and terminal (bottom/right). Monaco (MIT) is bundled locally and lazy-loaded so the app works offline and the rest of the UI stays light; the diff view uses Monaco's diff editor.

**What Guy can open (the "workspace" selector at the top of the IDE):**
1. **Main (mirror):** the orchestrator's read-only base clone of the default branch. Safe to browse; the orchestrator resets it on every sync, so editing is disabled here.
2. **My workspace:** a separate clone per project, `~/.software-factory/ide/<project>`, that only Guy (and nobody else, no agent) touches. This is where Guy edits, commits and pushes his own branches. This split is deliberate: the existing base clone is force-reset by the orchestrator and would silently destroy edits.
3. **An agent's workspace:** that agent's task worktree (host runner) or sbx clone (read through allowlisted `sbx exec`, or from the pushed branch). Read-only while the agent runs (see leases below).
4. **A folder project's real directory** (M5), editable, with the same leases.

**API (all under the loopback API token; JSON; paths relative to a workspace root):**
```
GET  /api/ws/:wid/tree?path=              list directory
GET  /api/ws/:wid/file?path=              text content + sha256 + language (binary: metadata only)
PUT  /api/ws/:wid/file?path=              save; body {content, base_sha}; 409 if base_sha != current (conflict)
POST /api/ws/:wid/fs                      {op: create|mkdir|rename|delete, path, to?}
GET  /api/ws/:wid/git/status              branch, ahead/behind, changes (staged/unstaged/untracked)
GET  /api/ws/:wid/git/diff?path=&staged=  or ?base=&head= / ?task=<id>; returns both sides for the Monaco diff editor
POST /api/ws/:wid/git/stage|unstage       {paths[]}
POST /api/ws/:wid/git/commit              {message}
GET  /api/ws/:wid/git/branches            POST /git/checkout {branch|create}   (refuses on a dirty tree)
POST /api/ws/:wid/git/push                pushes the current branch; never main/master (pre-push hook + API check)
GET  /api/ws/:wid/git/log?path=           recent commits
```
All git calls use `execFile` with argv arrays (no shell), `--` before paths, `status --porcelain=v2 -z`, and a command allowlist. Hunk-level staging is a later enhancement.

**Safety:**
1. *Path sandboxing:* every path is resolved against the workspace root with `realpath`; it must stay inside the root (blocks `..`, absolute paths, and symlinks pointing outside; such symlinks are listed but not followed). Case-insensitive file systems (Windows, macOS) compare normalised real paths. Writes additionally refuse `.git/`, and the workspace root itself.
2. *Secrets:* `.env*`, `*.pem`, `id_*`, `*.key` are listed but masked in the viewer unless Guy enables "show secrets" for that project.
3. *Limits:* 2 MB per file for the editor, binary detection, diff size caps with "load more".
4. *Concurrent edits, Guy vs agent* ("edit leases"): a workspace has an **owner** while a run is active on it (the agent's task worktree/clone). It opens **read-only** in the IDE with a banner "agent X is working here". Guy can **take over**: this soft-stops the run (checkpoint commit, task goes to `waiting_for_guy`), then the workspace becomes editable; when Guy is done he presses "hand back" (task re-queued with a note about his commit). Editing "anyway" is not offered. Saves also use `base_sha` optimistic concurrency, so a file changed on disk since it was opened returns 409 and Monaco shows a conflict diff. "My workspace" has no agent owner, so no lease is needed there.
5. *Guy's commits and pushes* go to branches only; the existing pre-push hook and the API refuse main/master. Merging stays a PR + Guy's click.
6. Loopback bind, API token, Host-header and Origin checks apply to every route above.

### 2.6b Terminals
- **Service:** a PTY service in the orchestrator using `@lydell/node-pty` (the same prebuilt-binary package JSM HQ uses: N-API prebuilds for win32-x64, darwin-arm64/x64, linux-x64, no compiler). Browser side: xterm.js with fit and web-links addons.
- **Transport:** WebSocket `/term?session=<id>&token=...` on the loopback API port; checks token, Origin and Host header; JSON control frames (resize) + binary data frames; sessions survive a page reload (ring buffer replay) and die with the orchestrator.
- **Session kinds:**
  1. *Guy's project terminal:* a login shell (cmd/PowerShell/zsh/bash per OS) with cwd = "My workspace" or any workspace he opens; an "any folder" option behind a setting. This is Guy's own shell with Guy's rights, exactly like opening a terminal in an editor.
  2. *Agent shell, host runner:* a shell in the agent's worktree (warning: same copy the agent is editing; shown next to the lease banner).
  3. *Agent shell, sandboxed:* `sbx exec -it <sandbox> bash` through the PTY, so Guy lands inside the microVM.
  4. *Agent live terminal (later):* attach to the agent CLI's own output; for v1 the structured log stream is shown, as today.
- **Windows:** ConPTY (Windows 10 1809+) via node-pty. Packaging: `esbuild` keeps `@lydell/node-pty` external; the Tauri build copies the matching platform package into the bundled resources next to `orchestrator.mjs` and `release.yml` already builds per target, so each installer contains only its own prebuild. `fix` step: chmod the macOS/Linux `spawn-helper` (HQ ships the same fix). A CI smoke test spawns a PTY, echoes a string and resizes on windows/macos/ubuntu runners. If the PTY cannot load, the terminal tab shows a clear error and falls back to a non-interactive command runner (no TTY), so the rest of the app is unaffected.
- **Safety:** one terminal grants a full shell, so it is gated by the same token as everything else, loopback only, no remote access, no sharing; sessions are listed (and killable) in the Activity board; ports are never forwarded automatically.

### 2.7 Who is doing what (Activity board)
A derived view, no new source of truth: join `agents`, `runs`, `tasks`, `projects` and the latest `events` row. Endpoint `GET /api/activity` plus a WebSocket `activity` event:
`{agent, state, project, task, task_type, status, branch, pr, runner, sandbox_name, started_at, last_heartbeat_at, tokens, last_event}` for live runs, and the last N finished runs for history, filterable by project/agent. UI: an Activity tab (table grouped by project, heartbeat age with a warning colour, click to open the live log or the task diff). Scripts appear in the same board.

### 2.7b Agent workspace drawer
Clicking an agent anywhere (cards, Activity board, kanban) opens a resizable drawer with tabs: **Overview** (state, task, branch, sandbox, heartbeat, tokens, controls: on/off, restart, stop), **Settings** (all profile fields from the Agents editor plus its role/instructions text and sandbox CPU/RAM with "recreate sandbox"), **Terminal** (2.6b), **Files** (the IDE view pinned to that agent's workspace, read-only under a lease), **Diff** (its task's branch vs base), **Messages** (its direct thread and bus messages), **Log** (live events). Everything in the drawer reuses the IDE, terminal and thread components; no separate implementation.

### 2.8 Unchanged principles
Local-only and free (no cloud services, in-process scheduler, SQLite + git), loopback API with token, merge/accept always by Guy, agent cap and budgets as the token-saving mechanism, `sbx` as the default isolation.

## 3. Milestones (small, ordered PRs)

The IDE pieces come early because they are the biggest day-to-day value and they do not depend on local tasks or automations.

| # | Milestone | What Guy sees afterwards |
|---|---|---|
| M0 | Foundations: migrations table (#27/#33), `projects.kind/root_path`, unified task columns | Nothing visibly new; existing data keeps working |
| M1 | IDE: browse and diff (read-only): workspace/file/git-read API with path sandboxing, IDE tab with file tree and Monaco tabs, git status and Monaco diff view, task diff panel | An IDE tab per project: browse files, open code with syntax highlighting, see uncommitted changes and what an agent changed on a task branch |
| M2 | IDE: edit and version control: save with conflict detection, create/rename/delete, stage/unstage, commit, branches, push branch, "My workspace" clone, edit leases and take-over | Edit code and commit like a normal IDE, in a separate workspace the agents never touch; agent worktrees are read-only while they work, with take-over |
| M3 | Terminals: PTY service, xterm.js, Guy's project terminal, sbx shell for sandboxed agents, node-pty bundled in installers and tested on Windows/macOS/Linux | A terminal per project and a shell inside any agent's sandbox |
| M4 | Agent workspace drawer + Activity board: tabs Overview/Settings/Terminal/Files/Diff/Messages/Log; live who-does-what table with branch, sandbox, heartbeat, history | Click an agent to see and control everything about it; one board of who is doing what |
| M5 | Local tasks and projects: folder/none projects, local + manual tasks, workspace repo mirror | Tasks that are not GitHub Issues on the same kanban, versioned in a local git repo; folder projects open in the IDE |
| M6 | Threads and inbox (adopting HQ "action items"): per-agent inbox, direct chat, ask kinds with buttons, network-access requests | One inbox grouped by agent; talk to any agent; approve with buttons |
| M7 | Automations (manual): definitions, run on host/sbx, streamed logs, history, script cap | Define a script, press Run, watch it, see outputs |
| M8 | Schedules, triggers, artifacts | Scripts run on their own; outputs appear as files in the IDE |
| M9 | Agents on folder projects: code tasks on folders with a local diff to accept, agent automations | Agents work on non-GitHub folders the same organized way |

Parallel track (needs Guy's machine): #24 sbx runner, #25 real provider streams, #26 Chief/`ask_guy` with a real model. Do them right after M0. Later/optional: #28, #29, #30, #31, tmux-style persistence so agents survive closing the app.

## 4. Decisions needed from Guy (defaults in bold)
1. **Where Guy edits.** **A separate "My workspace" clone per project, never touched by agents (recommended)** vs editing the orchestrator's mirror (unsafe: it is reset on sync) vs editing agents' worktrees directly (conflicts).
2. **Terminal power.** **Guy's terminal is a full shell with his rights, restricted to project workspaces by default, "any folder" as a setting (recommended)** vs unrestricted from day one.
3. **Local task storage and script runner** (from revision 1, unchanged): **SQLite + markdown in a local git repo with no remote; scripts default to `sbx`, host behind a warning; direct chat with agents is read-only advice, changes via tasks.** One yes covers these.
