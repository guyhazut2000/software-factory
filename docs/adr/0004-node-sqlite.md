# ADR 4: `node:sqlite` instead of Drizzle + better-sqlite3
Status: accepted (supersedes the Drizzle part of ADR 2)
Context: The orchestrator is bundled with a Node sidecar for Windows, macOS and Linux. `better-sqlite3` is a native module that would need per-platform prebuilds in every installer.
Decision: Use the built-in `node:sqlite` (Node 22.13+, which we bundle) with a small hand-written SQL schema in `packages/orchestrator/src/db.ts`. No native dependencies.
Consequences: Zero native build risk. No Drizzle migrations yet: schema changes use additive `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` until a migration table is added (open issue). `node:sqlite` is flagged experimental in Node 22 but stable enough for this use.
