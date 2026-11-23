# ADR 6: Unified tasks, local tasks mirrored as markdown in a local git repo
Status: proposed (default accepted unless Guy objects; see docs/PHASE2.md section 4)
Context: Guy wants git-backed and non-git work (scripts, automations, personal tasks) in one local, free environment, versioned via git, without cloud services.
Decision: One `tasks` table with `source` (github|local) and `type` (code|script|manual|review). Local tasks live canonically as markdown files with front matter in a local "workspace" git repo (no remote by default); SQLite keeps runtime state and an index, re-imports changed files on start. Automations are SQLite rows mirrored as YAML in the same repo. Projects may be a GitHub repo, a local folder or none.
Alternatives: markdown only (no runtime state, awkward queries); SQLite only (not versioned, not editable outside the app); a second task system next to GitHub Issues (two kanbans).
Consequences: Needs the migrations table first (#27). Two writers (app and editor) means a hash check on import. Everything stays local; a private remote can be added later without design changes.
