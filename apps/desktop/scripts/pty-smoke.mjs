// CI smoke test: lay out the sidecar resources in a temp dir (outside the repo, so the workspace node_modules
// can't help), then run the bundled `sf-node` sidecar binary there and spawn a real shell through node-pty.
// Usage: node scripts/pty-smoke.mjs [target-triple] (needs a built orchestrator and fetch-node.mjs for the host)
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const triple = process.argv[2] ?? execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
const win = process.platform === "win32";
const sidecar = path.join(here, "../src-tauri/binaries", `sf-node-${triple}${win ? ".exe" : ""}`);
if (!existsSync(sidecar)) throw new Error(`missing sidecar ${sidecar}; run fetch-node.mjs first`);
const res = path.join(mkdtempSync(path.join(os.tmpdir(), "sfsmoke-")), "resources");
execFileSync(process.execPath, [path.join(here, "prepare-resources.mjs"), triple, res], { stdio: "inherit" });

const helper = path.join(res, "node_modules/@lydell", `node-pty-${process.platform}-${process.arch}`, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
if (existsSync(helper)) chmodSync(helper, 0o644); // simulate a lost exec bit: the probe must repair it like pty.ts does

const probe = path.join(res, "pty-probe.mjs");
writeFileSync(probe, `
import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
const req = createRequire(new URL("./orchestrator.mjs", import.meta.url));
const pty = req("@lydell/node-pty");
const where = req.resolve("@lydell/node-pty");
if (!where.startsWith(${JSON.stringify(res)})) throw new Error("node-pty resolved outside resources: " + where);
const helper = ${JSON.stringify(helper)};
if (existsSync(helper)) { try { accessSync(helper, constants.X_OK); } catch { chmodSync(helper, 0o755); } }
const win = process.platform === "win32";
const file = win ? (process.env.COMSPEC || "cmd.exe") : (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
const args = win ? ["/c", "echo SF_PTY_%OS%_OK"] : ["-c", "echo SF_PTY_$((40+2))_OK"];
const want = win ? "SF_PTY_Windows_NT_OK" : "SF_PTY_42_OK";
const p = pty.spawn(file, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
let out = "";
const t = setTimeout(() => { console.error("timeout, output:", JSON.stringify(out)); process.exit(1); }, 20000);
p.onData((d) => { out += d; });
p.onExit(({ exitCode }) => {
  clearTimeout(t);
  setTimeout(() => {
    if (!out.includes(want)) { console.error("marker missing, exit", exitCode, JSON.stringify(out)); process.exit(1); }
    console.log("PTY OK via", where, "exit", exitCode);
    process.exit(0);
  }, 300);
});
`);
execFileSync(sidecar, [probe], { stdio: "inherit", cwd: res });
