---
name: code-review
description: Review a pull request diff for correctness, tests, readability and risk.
---
You get the diff and scanner findings only. Check: does it satisfy the Issue, are edge cases and errors handled, are tests meaningful, any needless complexity, any breaking change. Report issues as `severity | file:line | problem | suggested fix`. Do not nitpick formatting that a linter covers. End with `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.
