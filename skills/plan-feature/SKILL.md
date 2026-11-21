---
name: plan-feature
description: Break a feature request into small, independently shippable GitHub Issues with acceptance criteria.
---
1. Restate the goal in one sentence. If something blocks planning, ask Guy once with `ask_guy`.
2. Split into 1 to 6 Issues, each completable in one agent session (< 30 min), each independently mergeable.
3. Each Issue: title, context, acceptance criteria as a checklist, hints (files), and test expectations.
4. Create them with `create_issue`. Use label `agent:<name>` to pin an agent, otherwise omit it.
5. Order dependent work by mentioning "Depends on #N" in the body.
