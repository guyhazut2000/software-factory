import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha } from "./files.js";
import { fsOp, saveFile } from "./write.js";

let root: string, outside: string;
const st = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { status: number }).status;
  }
  return 200;
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sf-w-"));
  outside = mkdtempSync(path.join(tmpdir(), "sf-wo-"));
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, "a.txt"), "one");
});

describe("saveFile", () => {
  it("saves when base_sha matches and returns the new sha", () => {
    const r = saveFile(root, "a.txt", "two", sha("one"));
    expect(r).toEqual({ path: "a.txt", sha256: sha("two"), size: 3 });
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("two");
  });
  it("409 with current_sha on a stale base, file untouched", () => {
    try {
      saveFile(root, "a.txt", "two", sha("old"));
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 409, extra: { conflict: true, current_sha: sha("one") } });
    }
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one");
  });
  it("create needs base_sha null; a deleted file is a 409 with current_sha null", () => {
    expect(st(() => saveFile(root, "a.txt", "x", null))).toBe(409);
    expect(saveFile(root, "new.txt", "n", null).sha256).toBe(sha("n"));
    try {
      saveFile(root, "gone.txt", "x", sha("y"));
    } catch (e) {
      expect(e).toMatchObject({ status: 409, extra: { current_sha: null } });
    }
  });
  it("refuses root, .git, escapes, symlinks out, missing parents and non-strings", () => {
    expect(st(() => saveFile(root, "", "x", null))).toBe(400);
    expect(st(() => saveFile(root, ".git/config", "x", null))).toBe(403);
    expect(st(() => saveFile(root, "sub/.GIT/x", "x", null))).toBe(403);
    expect(st(() => saveFile(root, "../x", "x", null))).toBe(400);
    expect(st(() => saveFile(root, "/etc/x", "x", null))).toBe(400);
    expect(st(() => saveFile(root, "nope/x", "x", null))).toBe(404);
    expect(st(() => saveFile(root, "a.txt", 5, sha("one")))).toBe(400);
  });
  it.skipIf(process.platform === "win32")("refuses symlinks that point outside", () => {
    symlinkSync(outside, path.join(root, "out"));
    writeFileSync(path.join(outside, "f"), "x");
    symlinkSync(path.join(outside, "f"), path.join(root, "outf"));
    expect(st(() => saveFile(root, "out/x", "x", null))).toBe(403);
    expect(st(() => saveFile(root, "outf", "y", sha("x")))).toBe(403);
    expect(readFileSync(path.join(outside, "f"), "utf8")).toBe("x");
  });
});

describe("fsOp", () => {
  it("create, mkdir, rename, delete", () => {
    expect(fsOp(root, { op: "mkdir", path: "d" })).toMatchObject({ ok: true });
    expect(fsOp(root, { op: "create", path: "d/f.ts" })).toMatchObject({ path: "d/f.ts" });
    expect(st(() => fsOp(root, { op: "create", path: "d/f.ts" }))).toBe(409);
    expect(fsOp(root, { op: "rename", path: "d/f.ts", to: "d/g.ts" })).toMatchObject({ path: "d/g.ts" });
    expect(st(() => fsOp(root, { op: "rename", path: "d/g.ts", to: "a.txt" }))).toBe(409);
    expect(st(() => fsOp(root, { op: "rename", path: "d", to: "d/inner" }))).toBe(400);
    expect(fsOp(root, { op: "delete", path: "d" })).toMatchObject({ ok: true });
    expect(existsSync(path.join(root, "d"))).toBe(false);
    expect(st(() => fsOp(root, { op: "delete", path: "d" }))).toBe(404);
    expect(st(() => fsOp(root, { op: "nuke", path: "a.txt" }))).toBe(400);
  });
  it("refuses root and .git", () => {
    expect(st(() => fsOp(root, { op: "delete", path: "" }))).toBe(400);
    expect(st(() => fsOp(root, { op: "delete", path: ".git" }))).toBe(403);
    expect(st(() => fsOp(root, { op: "rename", path: "a.txt", to: ".git/a" }))).toBe(403);
  });
  it.skipIf(process.platform === "win32")("deletes a symlink itself rather than its target", () => {
    mkdirSync(path.join(root, "real"));
    writeFileSync(path.join(root, "real", "k"), "keep");
    symlinkSync(path.join(root, "real"), path.join(root, "link"));
    fsOp(root, { op: "delete", path: "link" });
    expect(readFileSync(path.join(root, "real", "k"), "utf8")).toBe("keep");
  });
});
