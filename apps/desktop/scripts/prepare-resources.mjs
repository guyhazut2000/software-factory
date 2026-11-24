// Copies the built orchestrator bundle + skills + the node-pty prebuild for the target into src-tauri/resources.
// Usage: node scripts/prepare-resources.mjs [target-triple] [outDir]
// The target defaults to $SF_TARGET_TRIPLE (release.yml), then $TAURI_ENV_TARGET_TRIPLE (set by `tauri build --target`), then the rustc host.
import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.resolve(process.argv[3] ?? path.join(root, "apps/desktop/src-tauri/resources"));
const src = path.join(root, "packages/orchestrator/dist/orchestrator.mjs");
if (!existsSync(src)) throw new Error("Build the orchestrator first: pnpm --filter @sf/orchestrator build");

/** Walk up from a resolved entry file to its package root (packages here don't export ./package.json). */
function pkgRoot(file) {
  let d = path.dirname(file);
  while (!existsSync(path.join(d, "package.json"))) d = path.dirname(d);
  return d;
}
const hostTriple = () => execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
const triple = process.argv[2] || process.env.SF_TARGET_TRIPLE || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const map = {
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-pc-windows-msvc": "win32-x64",
};
const plat = map[triple];
if (!plat) throw new Error(`Unsupported target ${triple}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, path.join(out, "orchestrator.mjs"));
cpSync(path.join(root, "skills"), path.join(out, "skills"), { recursive: true });

// node-pty: the JS wrapper + the one platform package, laid out as resources/node_modules so that
// createRequire(resources/orchestrator.mjs)("@lydell/node-pty") resolves exactly as in dev.
const req = createRequire(path.join(root, "packages/orchestrator/package.json"));
const wrapperDir = pkgRoot(req.resolve("@lydell/node-pty"));
const version = JSON.parse(readFileSync(path.join(wrapperDir, "package.json"), "utf8")).version;
const nm = path.join(out, "node_modules/@lydell");
mkdirSync(nm, { recursive: true });
cpSync(wrapperDir, path.join(nm, "node-pty"), { recursive: true, dereference: true });

const platName = `node-pty-${plat}`;
const platDest = path.join(nm, platName);
let platDir;
try {
  platDir = pkgRoot(createRequire(path.join(wrapperDir, "index.js")).resolve(`@lydell/${platName}`));
} catch {
  platDir = undefined; // not installed for this host (cross-target build): fetch it from the registry
}
if (platDir) {
  cpSync(platDir, platDest, { recursive: true, dereference: true });
} else {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sfpty-"));
  const url = `https://registry.npmjs.org/@lydell/${platName}/-/${platName}-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const tgz = path.join(tmp, "pkg.tgz");
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  execSync(`tar -xzf pkg.tgz`, { cwd: tmp });
  cpSync(path.join(tmp, "package"), platDest, { recursive: true });
}
// npm tarballs / copies can drop the exec bit; node-pty fails with "posix_spawnp failed" without it.
const helper = path.join(platDest, "prebuilds", plat, "spawn-helper");
if (existsSync(helper)) chmodSync(helper, 0o755);
const native = path.join(platDest, "prebuilds", plat, plat.startsWith("win32") ? "conpty.node" : "pty.node");
if (!existsSync(native)) throw new Error(`no node-pty prebuild for ${plat}: ${native}`);
console.log(`resources prepared in ${out} (node-pty ${version} ${plat})`);
