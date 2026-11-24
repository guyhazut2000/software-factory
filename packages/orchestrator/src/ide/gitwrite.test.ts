import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { branches, checkout, commit, createBranch, push, stage, unstage } from "./gitwrite.js";

let root: string, bare: string;
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd }).toString().trim();
const staged = () => g(root, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
const status = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { status: number }).status;
  }
  return 200;
};

beforeEach(() => {
  bare = mkdtempSync(path.join(tmpdir(), "sf-bare-"));
  g(bare, "init", "-q", "--bare", "-b", "main");
  root = mkdtempSync(path.join(tmpdir(), "sf-gw-"));
  g(root, "init", "-q", "-b", "main");
  g(root, "config", "user.name", "t");
  g(root, "config", "user.email", "t@t");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  g(root, "add", "-A");
  g(root, "commit", "-qm", "base");
  g(root, "remote", "add", "origin", bare);
  g(root, "push", "-q", "origin", "main");
});

describe("git write api", () => {
  it("stages, unstages and commits", async () => {
    writeFileSync(path.join(root, "a.txt"), "two\n");
    writeFileSync(path.join(root, "b.txt"), "b\n");
    await stage(root, { paths: ["a.txt", "b.txt"] });
    expect(staged().sort()).toEqual(["a.txt", "b.txt"]);
    await unstage(root, { paths: ["b.txt"] });
    expect(staged()).toEqual(["a.txt"]);
    expect(await status(stage(root, { paths: ["../x"] }))).toBe(400);
    expect(await status(stage(root, { paths: [] }))).toBe(400);
    expect(await status(commit(root, { message: "  " }))).toBe(400);
    const c = await commit(root, { message: "edit a" });
    expect(c.branch).toBe("main");
    expect(g(root, "log", "-1", "--format=%s")).toBe("edit a");
    expect(await status(commit(root, { message: "again" }))).toBe(400); // nothing staged
  });

  it("lists, creates and checks out branches; refuses checkout on a dirty tree", async () => {
    await createBranch(root, { name: "feat/x" });
    let br = await branches(root);
    expect(br.current).toBe("main");
    expect(br.local.map((b) => b.name).sort()).toEqual(["feat/x", "main"]);
    expect(br.remote.map((b) => b.name)).toEqual(["main"]);
    expect(await status(createBranch(root, { name: "feat/x" }))).toBe(409);
    expect(await status(createBranch(root, { name: "-f" }))).toBe(400);
    expect(await status(createBranch(root, { name: "bad name" }))).toBe(400);
    expect(await status(createBranch(root, { name: "a.lock" }))).toBe(400);
    writeFileSync(path.join(root, "a.txt"), "dirty\n");
    expect(await status(checkout(root, { name: "feat/x" }))).toBe(409);
    expect(await status(createBranch(root, { name: "feat/y", checkout: true }))).toBe(409);
    expect(g(root, "branch", "--show-current")).toBe("main");
    g(root, "checkout", "--", "a.txt");
    writeFileSync(path.join(root, "untracked.txt"), "u\n"); // untracked files do not block
    br = await checkout(root, { name: "feat/x" });
    expect(br.current).toBe("feat/x");
    expect(await status(checkout(root, { name: "nope" }))).toBe(404);
    br = await createBranch(root, { name: "feat/z", from: "main", checkout: true });
    expect(br.current).toBe("feat/z");
  });

  it("pushes feature branches to the bare remote, never main/master/default", async () => {
    await createBranch(root, { name: "feat/p", checkout: true });
    writeFileSync(path.join(root, "p.txt"), "p\n");
    await stage(root, { all: true });
    await commit(root, { message: "p" });
    expect(await push(root, {})).toEqual({ pushed: "feat/p", remote: "origin" });
    expect(g(bare, "rev-parse", "refs/heads/feat/p")).toBe(g(root, "rev-parse", "HEAD"));
    expect((await branches(root)).local.find((b) => b.name === "feat/p")?.upstream).toBe("origin/feat/p");
    const mainSha = g(bare, "rev-parse", "refs/heads/main");
    expect(await status(push(root, { branch: "main" }))).toBe(403);
    expect(await status(push(root, { branch: "master" }))).toBe(403);
    expect(await status(push(root, { branch: "feat/p" }, "feat/p"))).toBe(403);
    expect(await status(push(root, { branch: "main:main" }))).toBe(400);
    expect(await status(push(root, { branch: "--force" }))).toBe(400);
    g(root, "checkout", "-q", "main");
    expect(await status(push(root, {}))).toBe(403); // current branch is main
    expect(g(bare, "rev-parse", "refs/heads/main")).toBe(mainSha);
    // a remote-only branch can be checked out as a tracking branch
    g(root, "branch", "-q", "-D", "feat/p");
    expect((await checkout(root, { name: "feat/p" })).current).toBe("feat/p");
  });
});
