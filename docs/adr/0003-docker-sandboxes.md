# ADR 3: Docker Sandboxes (`sbx`) for isolation
Status: accepted
Context: Agents run autonomously with broad permissions; they must not touch Guy's host. No paid cloud.
Decision: One `sbx` microVM per running agent, clone mode, deny-by-default network policy allowing only GitHub and the model provider. Secrets injected via `sbx secret`, never in the repo.
Consequences: Strong isolation and private Docker engine per agent, free locally. Costs RAM per agent, hence a global concurrency cap. Depends on `sbx` CLI stability; wrap it behind a `SandboxDriver` interface.
