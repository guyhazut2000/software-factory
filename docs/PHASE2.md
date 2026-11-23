# Phase 2: a local personal work environment

Scope (from Guy): local-only, free. One place to manage his tasks and projects: git-backed work (GitHub Issues/PRs per linked repo) AND non-git work (scripts, automations, data jobs, misc tasks). Agents work per project in an organized way. Guy talks mainly to the Chief but can talk to any agent (inbox of pending asks, threads). He can browse each project's files, see diffs of agent work, and see who is doing what, live.

This document is the audit and design only. Nothing here is built yet.

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

### 2.6 File viewer and diffs (read-only)
API (all GET, all under the API token; nothing writes):
```
GET /api/projects/:id/tree?path=&ref=        directory listing (name, type, size)
GET /api/projects/:id/file?path=&ref=        text content (+ language, truncated flag); binaries return metadata only
GET /api/projects/:id/diff?task=<id>         diff of a task's branch vs base (or local diff for folder projects)
GET /api/projects/:id/diff?base=&head=       arbitrary refs
GET /api/projects/:id/log?path=              recent commits touching a path
```
Safety model:
1. Every path is resolved against the project root with `realpath`; the result must stay inside the root (blocks `..`, absolute paths, and symlinks pointing outside; symlinked entries are shown but not followed outside).
2. `.git/` internals are never served; `.env*`, `*.pem`, `id_*`, `*.key` are listed but their content is masked unless Guy enables "show secrets" for that project.
3. Size cap (1 MB per file, 2000 lines of diff by default, "load more"), binary detection, no execution, no writes.
4. For git projects `ref` defaults to the default branch and content is read with `git show`/`git ls-tree` (no working-tree races). A task's live WIP in an `sbx` clone is read through `sbx exec git ...` (read-only commands from an allowlist); after push it is read from the host clone's fetched branch.
5. Rate/size limits and the loopback-only bind already apply.
UI: a Files tab per project (tree + code view + task/branch selector) and a Diff panel on each task card (files changed, unified diff, "open in file viewer").

### 2.7 Who is doing what (Activity board)
A derived view, no new source of truth: join `agents`, `runs`, `tasks`, `projects` and the latest `events` row. Endpoint `GET /api/activity` plus a WebSocket `activity` event:
`{agent, state, project, task, task_type, status, branch, pr, runner, sandbox_name, started_at, last_heartbeat_at, tokens, last_event}` for live runs, and the last N finished runs for history, filterable by project/agent. UI: an Activity tab (table grouped by project, heartbeat age with a warning colour, click to open the live log or the task diff). Scripts appear in the same board.

### 2.8 Unchanged principles
Local-only and free (no cloud services, in-process scheduler, SQLite + git), loopback API with token, merge/accept always by Guy, agent cap and budgets as the token-saving mechanism, `sbx` as the default isolation.

## 3. Milestones (small, ordered PRs)

| # | Milestone | What Guy sees afterwards |
|---|---|---|
| M0 | Foundations: migrations table (#27), `projects.kind/root_path`, unified task columns, API compatibility kept | Nothing visibly new; existing data keeps working |
| M1 | Local tasks and projects: folder/none projects, create/edit local + manual tasks, workspace repo mirror, import on start | Add a folder or "Personal" project, create tasks that are not Issues, they show on the same kanban with a source badge and are committed in the workspace repo |
| M2 | Activity board: `/api/activity`, Activity tab, branch/sandbox/heartbeat/history | A live table of who is doing what, where, with branch and sandbox |
| M3 | File viewer: tree/file/log API with path sandboxing, Files tab | Browse any project's files, read-only |
| M4 | Diffs of agent work: task diff API/panel, accept/merge flow for local diffs | See exactly what an agent changed, on each task |
| M5 | Threads and inbox: schema migration, per-agent inbox, direct chat, ask kinds/options | Inbox grouped by agent; talk to any agent; answer approvals with buttons |
| M6 | Automations (manual): definitions, run on host/sbx, streamed logs, run history, script cap | Define a script, press Run, watch its log, see outputs |
| M7 | Schedules, triggers and artifacts: cron/interval, run-on-start for missed, artifacts in the file viewer | Scripts run on their own; outputs appear as files |
| M8 | Agent work on folder/none projects: `code` tasks on folders (local diff to accept), agent automations | Agents work on non-GitHub folders the same organized way |

Parallel track (needs Guy's machine, gates trust in everything above): #24 sbx runner, #25 real provider streams, #26 Chief/`ask_guy` with a real model. Recommended to do them right after M0, because they can invalidate assumptions. Later/optional: #28, #29, #30, #31.

## 4. Decisions needed from Guy (defaults in bold)
1. **Local task storage.** **SQLite for runtime + markdown files in a local workspace git repo with no remote (recommended)** vs markdown only vs SQLite only.
2. **Script default runner.** **`sbx` (isolated); `host` per automation behind a warning (recommended)** vs host by default.
3. **Direct chat with agents.** **Read-only advice; changes only via tasks (recommended)** vs letting a direct chat edit files.
