// Downloads the official Node.js 22 binary for a Rust target triple and stores it as the Tauri sidecar `sf-node`.
// Usage: node scripts/fetch-node.mjs [target-triple]
import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const triple = process.argv[2] ?? execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
const map = {
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-pc-windows-msvc": "win-x64",
};
const plat = map[triple];
if (!plat) throw new Error(`Unsupported target ${triple}`);
const win = plat.startsWith("win");
const base = "https://nodejs.org/dist/latest-v22.x";
const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
const version = sums.match(/node-(v22\.\d+\.\d+)-/)[1];
const outDir = path.join(here, "../src-tauri/binaries");
mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, `sf-node-${triple}${win ? ".exe" : ""}`);

if (win) {
  const buf = Buffer.from(await (await fetch(`https://nodejs.org/dist/${version}/win-x64/node.exe`)).arrayBuffer());
  writeFileSync(dest, buf);
} else {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sfnode-"));
  const name = `node-${version}-${plat}`;
  const tgz = path.join(tmp, `${name}.tar.gz`);
  writeFileSync(tgz, Buffer.from(await (await fetch(`https://nodejs.org/dist/${version}/${name}.tar.gz`)).arrayBuffer()));
  execSync(`tar -xzf "${tgz}" -C "${tmp}" ${name}/bin/node`);
  copyFileSync(path.join(tmp, name, "bin/node"), dest);
  chmodSync(dest, 0o755);
}
console.log(`sidecar ${dest} (node ${version})`);
