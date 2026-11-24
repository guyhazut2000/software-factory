import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atRef, disk, verifyRef } from "./files.js";
import { cleanRel } from "./paths.js";
import { gitLog } from "./routes.js";
import type { IdeWorkspace } from "./workspaces.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).toString();
let root: string, outside: string, first: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sf-ide-"));
  outside = mkdtempSync(path.join(tmpdir(), "sf-out-"));
  writeFileSync(path.join(outside, "secret.txt"), "outside");
  g(root, "init", "-q", "-b", "main");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "README.md"), "# hi\n");
  g(root, "add", "-A");
  g(root, "commit", "-qm", "first");
  first = g(root, "rev-parse", "HEAD").trim();
  writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(path.join(root, ".env"), "TOKEN=abc");
  writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 0, 2, 3]));
  writeFileSync(path.join(root, "big.txt"), "x".repeat(2 * 1024 * 1024 + 1));
  g(root, "add", "-A");
  g(root, "commit", "-qm", "second");
  try {
    symlinkSync(outside, path.join(root, "escape"), "junction");
    symlinkSync(path.join(root, "src"), path.join(root, "srclink"), "junction");
  } catch { /* symlinks may need privileges on Windows */ }
});

describe("path sandboxing", () => {
  it("rejects traversal, absolute and drive paths", () => {
    for (const bad of ["../x", "src/../../x", "/etc/passwd", "C:\\Windows", "a\0b", "..\\x"]) expect(() => cleanRel(bad)).toThrow();
    expect(cleanRel("./src//a.ts")).toBe("src/a.ts");
    expect(cleanRel("src\\a.ts")).toBe("src/a.ts");
  });
  it("refuses reading through traversal or symlinks that leave the root", () => {
    expect(() => disk.file(root, "../" + path.basename(outside) + "/secret.txt")).toThrow();
    expect(() => disk.file(root, path.join(outside, "secret.txt"))).toThrow(/absolute/);
    expect(() => disk.file(root, "escape/secret.txt")).toThrow();
    expect(() => disk.tree(root, "escape")).toThrow();
  });
});

describe("disk files", () => {
  it("lists a directory, dirs first, .git hidden, outside symlinks flagged", () => {
    const t = disk.tree(root, "");
    expect(t.find((e) => e.name === ".git")).toBeUndefined();
    expect(t[0].type).toBe("dir");
    expect(t.find((e) => e.name === ".env")?.secret).toBe(true);
    const esc = t.find((e) => e.name === "escape");
    if (esc) expect(esc).toMatchObject({ type: "symlink", outside: true });
    const inner = t.find((e) => e.name === "srclink");
    if (inner) expect(inner.type).toBe("dir");
  });
  it("reads text with sha and language; masks secrets; flags binary and large files", () => {
    const f = disk.file(root, "src/a.ts");
    expect(f).toMatchObject({ content: "export const a = 2;\n", language: "typescript" });
    expect(f.sha256).toHaveLength(64);
    expect(disk.file(root, ".env")).toMatchObject({ masked: true });
    expect(disk.file(root, ".env").content).toBeUndefined();
    expect(disk.file(root, ".env", true).content).toBe("TOKEN=abc");
    expect(disk.file(root, "bin.dat")).toMatchObject({ binary: true });
    expect(disk.file(root, "big.txt")).toMatchObject({ too_large: true });
    expect(() => disk.file(root, "nope.txt")).toThrow(/not found/);
  });
});

describe("files at a git ref", () => {
  it("reads trees and files at an older commit", async () => {
    const ref = await verifyRef(root, first);
    const t = await atRef.tree(root, ref, "");
    expect(t.map((e) => e.name)).toEqual(["src", "README.md"]);
    expect((await atRef.file(root, ref, "src/a.ts")).content).toBe("export const a = 1;\n");
    await expect(atRef.file(root, ref, "big.txt")).rejects.toThrow(/not found/);
    expect((await atRef.file(root, "HEAD", "big.txt")).too_large).toBe(true);
    expect((await atRef.file(root, "HEAD", ".env")).masked).toBe(true);
  });
  it("refuses option-like or unknown refs", async () => {
    await expect(verifyRef(root, "--output=/tmp/x")).rejects.toThrow(/bad ref/);
    await expect(verifyRef(root, "main..HEAD")).rejects.toThrow(/bad ref/);
    await expect(verifyRef(root, "no-such-branch")).rejects.toThrow(/unknown ref/);
    expect(await verifyRef(root, "main")).toHaveLength(40);
  });
  it("logs commits, optionally per path", async () => {
    const w = { root, git: true } as IdeWorkspace;
    const all = await gitLog(w, undefined, "");
    expect(all.map((c) => c.subject)).toEqual(["second", "first"]);
    expect((await gitLog(w, undefined, "README.md")).map((c) => c.subject)).toEqual(["first"]);
  });
});
