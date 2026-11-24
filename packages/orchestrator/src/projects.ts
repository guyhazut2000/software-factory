import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Db, Row } from "./db.js";
import { repoDirFor } from "./workspace.js";
import { now, uid } from "./util.js";

export type ProjectKind = "github" | "folder" | "none";

/** Resolve and check a folder for a `folder` project: absolute, exists, a directory, not a filesystem root. It need not be a git repo. */
export function validateFolder(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || !path.isAbsolute(raw)) throw new Error("root_path must be an absolute folder path");
  let root: string;
  let st;
  try {
    root = realpathSync(raw);
    st = statSync(root);
  } catch {
    throw new Error(`Folder not found: ${raw}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a folder: ${raw}`);
  if (path.parse(root).root === root) throw new Error("A drive or filesystem root cannot be a project");
  return root;
}

/** Validate and build a `folder` or `none` project row (no GitHub involved). */
export function newLocalProject(b: { kind?: unknown; name?: unknown; root_path?: unknown }): Row {
  const kind = b.kind as ProjectKind;
  if (kind !== "folder" && kind !== "none") throw new Error("kind must be folder or none");
  const root = kind === "folder" ? validateFolder(b.root_path) : null;
  const name = (typeof b.name === "string" && b.name.trim()) || (root ? path.basename(root) : "");
  if (!name) throw new Error("name required");
  return { id: uid(), name: name.slice(0, 120), kind, repo: null, root_path: root, default_branch: "main", instructions: "", created_at: now() };
}

/** GitHub projects linked before v2 have no root_path: point them at their base clone. */
export function backfillRoots(db: Db): void {
  for (const p of db.all("SELECT id, repo FROM projects WHERE kind='github' AND root_path IS NULL")) db.update("projects", p.id, { root_path: repoDirFor(p.repo) });
}

/** Fields Guy may change on a project: instructions always; name for folder/none; root_path (relink) for folder. */
export function projectPatch(db: Db, p: Row, b: Record<string, unknown>): Row {
  const out: Row = {};
  if (b.instructions !== undefined) out.instructions = String(b.instructions ?? "");
  if (b.name !== undefined) {
    if (p.kind === "github") throw new Error("GitHub project names follow the repo");
    const name = String(b.name ?? "").trim();
    if (!name) throw new Error("name required");
    out.name = name.slice(0, 120);
  }
  if (b.root_path !== undefined) {
    if (p.kind !== "folder") throw new Error("Only folder projects can be relinked");
    const root = validateFolder(b.root_path);
    if (db.get("SELECT 1 AS x FROM projects WHERE root_path=? AND kind='folder' AND id<>?", root, p.id)) throw new Error("That folder is already a project");
    out.root_path = root;
  }
  return out;
}
