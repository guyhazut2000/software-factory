// Copies the built orchestrator bundle + skills into src-tauri/resources (bundled into installers).
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.join(root, "apps/desktop/src-tauri/resources");
const src = path.join(root, "packages/orchestrator/dist/orchestrator.mjs");
if (!existsSync(src)) throw new Error("Build the orchestrator first: pnpm --filter @sf/orchestrator build");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, path.join(out, "orchestrator.mjs"));
cpSync(path.join(root, "skills"), path.join(out, "skills"), { recursive: true });
console.log("resources prepared in", out);
