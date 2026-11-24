import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diffFiles, diffPair, diffSpec, status } from "./gitread.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).toString();
let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sf-git-"));
  g(root, "init", "-q", "-b", "main");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  writeFileSync(path.join(root, "b.txt"), "bee\n");
  writeFileSync(path.join(root, "old name.txt"), "rename me, a long enough body so similarity is obvious\n");
  g(root, "add", "-A");
  g(root, "commit", "-qm", "base");
  g(root, "checkout", "-q", "-b", "feature");
  writeFileSync(path.join(root, "c.txt"), "new on feature\n");
  g(root, "add", "-A");
  g(root, "commit", "-qm", "feature work");
  // working tree: one staged edit, one unstaged edit, one rename (staged), one delete, one untracked
  writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
  g(root, "add", "a.txt");
  writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\n");
  renameSync(path.join(root, "old name.txt"), path.join(root, "new name.txt"));
  g(root, "add", "-A", "old name.txt", "new name.txt");
  rmSync(path.join(root, "b.txt"));
  writeFileSync(path.join(root, "untracked.md"), "u");
});

describe("git status", () => {
  it("parses porcelain v2 with branch, staged, unstaged, renames and untracked", async () => {
    const s = await status(root);
    expect(s.branch).toBe("feature");
    const by = Object.fromEntries(s.changes.map((c) => [c.path, c]));
    expect(by["a.txt"]).toMatchObject({ staged: "M", unstaged: "M" });
    expect(by["new name.txt"]).toMatchObject({ staged: "R", orig_path: "old name.txt" });
    expect(by["b.txt"]).toMatchObject({ staged: ".", unstaged: "D" });
    expect(by["untracked.md"]).toMatchObject({ untracked: true });
  });
});

describe("git diff", () => {
  it("unstaged: index vs working tree", async () => {
    const d = await diffSpec(root, { mode: "unstaged" });
    const files = (await diffFiles(root, d)).files.map((f) => `${f.status} ${f.path}`);
    expect(files).toEqual(expect.arrayContaining(["M a.txt", "D b.txt", "? untracked.md"]));
    const p = await diffPair(root, d, "a.txt", undefined, false);
    expect(p.original.content).toBe("one\ntwo\n");
    expect(p.modified.content).toBe("one\ntwo\nthree\n");
    const del = await diffPair(root, d, "b.txt", undefined, false);
    expect(del.original.content).toBe("bee\n");
    expect(del.modified.exists).toBe(false);
  });
  it("staged: HEAD vs index, with renames", async () => {
    const d = await diffSpec(root, { mode: "staged" });
    const files = (await diffFiles(root, d)).files;
    expect(files.find((f) => f.status === "R")).toMatchObject({ orig_path: "old name.txt", path: "new name.txt" });
    const p = await diffPair(root, d, "a.txt", undefined, false);
    expect([p.original.content, p.modified.content]).toEqual(["one\n", "one\ntwo\n"]);
  });
  it("range: merge-base(main, feature) vs feature (task branch vs base)", async () => {
    const d = await diffSpec(root, { mode: "range", base: "main", head: "feature" });
    expect((await diffFiles(root, d)).files).toEqual([{ status: "A", path: "c.txt" }]);
    const p = await diffPair(root, d, "c.txt", undefined, false);
    expect(p.original.exists).toBe(false);
    expect(p.modified.content).toBe("new on feature\n");
    const live = await diffSpec(root, { mode: "range", base: "main", worktree: true });
    expect((await diffFiles(root, live)).files.map((f) => f.path)).toEqual(expect.arrayContaining(["c.txt", "a.txt", "untracked.md"]));
  });
  it("validates input", async () => {
    await expect(diffSpec(root, { mode: "range" })).rejects.toThrow(/base required/);
    await expect(diffSpec(root, { mode: "range", base: "-x" })).rejects.toThrow(/bad ref/);
    await expect(diffSpec(root, { mode: "rm -rf" })).rejects.toThrow(/mode/);
    const d = await diffSpec(root, { mode: "unstaged" });
    await expect(diffPair(root, d, "../etc/passwd", undefined, false)).rejects.toThrow();
  });
});
