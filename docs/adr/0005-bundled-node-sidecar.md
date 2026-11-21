# ADR 5: Orchestrator as a bundled Node sidecar
Status: accepted
Context: The orchestrator is TypeScript. Guy's work machine has unknown software installed and GUI apps do not inherit the login shell PATH.
Decision: Ship an official Node 22 binary inside the installer as a Tauri `externalBin` (`sf-node`) and run the esbuild-bundled `orchestrator.mjs` (resource) with it on random localhost ports and a random per-launch API token. The Rust side reads the login-shell PATH on macOS/Linux so `gh`, `sbx` and provider CLIs are found. Sandboxes reach a second, per-run-token listener (MCP + hooks).
Alternatives: relying on system Node (fragile), `pkg`/SEA single binary (native module and cross-build pain), rewriting in Rust (too slow for the MVP).
Consequences: Installers are about 80 MB larger. No Node prerequisite. The UI never touches git, sbx or the database directly.
