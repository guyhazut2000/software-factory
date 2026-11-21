---
name: implement-issue
description: Implement a GitHub Issue end to end with minimal changes: read context, plan, edit, test, commit. Use when assigned an Issue.
---
1. Call `get_task_context` (factory MCP) for the Issue, prior summary and Guy's answers.
2. Read only the files you need. Prefer search over opening whole directories.
3. Make the smallest change that satisfies the acceptance criteria. Follow existing conventions.
4. Run the project's lint, typecheck and tests; fix failures you caused.
5. Commit with a clear message referencing the issue (`Closes #N` goes in the PR, not needed in commits).
6. Call `report_progress` after each milestone (one short sentence). If you need a decision from Guy, call `ask_guy` and stop. If the environment is broken, call `request_restart`.
7. Never push, force-push, or touch main. Never read secrets or credentials.
8. Finish with a 3-line summary: what changed, how it was tested, risks.
