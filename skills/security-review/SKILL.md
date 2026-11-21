---
name: security-review
description: Security review of a diff using pre-computed scanner findings (ESLint, Semgrep, gitleaks, npm audit).
---
Triage the scanner findings first: mark each as real, false positive, or needs context, with one line of justification. Then scan the diff for what tools miss: injection, authz gaps, unsafe deserialization, secrets in code, path traversal, SSRF, weak crypto, overly broad permissions, dependency additions. Any leaked secret is CHANGES_REQUESTED. End with `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.
