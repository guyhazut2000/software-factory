# ADR 1: Tauri over Electron
Status: accepted
Context: A desktop dashboard that runs next to heavy microVMs; RAM matters.
Decision: Tauri 2 with a React frontend. The orchestrator runs as a separate Node sidecar process, so the UI is a thin client over WebSocket/HTTP.
Consequences: Small footprint and native notifications. Requires Rust toolchain for builds. Since UI only talks to the orchestrator, switching to Electron later is cheap.
