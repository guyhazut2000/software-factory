import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/orchestrator.mjs",
  // native module: loaded at runtime from node_modules / the bundled resources (M3.3)
  external: ["@lydell/node-pty"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
mkdirSync("dist", { recursive: true });
cpSync("../../skills", "dist/skills", { recursive: true });
console.log("built dist/orchestrator.mjs");
