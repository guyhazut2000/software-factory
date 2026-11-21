# ADR 2: SQLite with Drizzle
Status: accepted
Context: Single-user, local, no cloud. Needs durable task state, messages, questions and costs, surviving restarts.
Decision: SQLite file (WAL mode) via better-sqlite3, schema and migrations with Drizzle.
Consequences: Zero ops, trivially backed up. Single writer: only the orchestrator process touches the DB; UI reads via its API.
