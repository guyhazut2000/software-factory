import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Db, Row } from "./db.js";
import { repoDirFor } from "./workspace.js";
import { now, uid } from "./util.js";

export type ProjectKind = "github" | "folder" | "none";

/** Validate and build a `folder` or `none` project row (no GitHub involved). */
export function newLocalProject(b: { kind?: unknown; name?: unknown; root_path?: unknown }): Row {
  const kind = b.kind as ProjectKind;
  if (kind !== "folder" && kind !== "none") throw new Error("kind must be folder or none");
  let root: string | null = null;
  if (kind === "folder") {
    const raw = typeof b.root_path === "string" ? b.root_path.trim() : "";
    if (!raw || !path.isAbsolute(raw)) throw new Error("root_path must be an absolute folder path");
    let st;
    try {
      root = realpathSync(raw);
      st = statSync(root);
    } catch {
      throw new Error(`Folder not found: ${raw}`);
    }
    if (!st.isDirectory()) throw new Error(`Not a folder: ${raw}`);
    if (path.parse(root).root === root) throw new Error("A drive or filesystem root cannot be a project");
  }
  const name = (typeof b.name === "string" && b.name.trim()) || (root ? path.basename(root) : "");
  if (!name) throw new Error("name required");
  return { id: uid(), name: name.slice(0, 120), kind, repo: null, root_path: root, default_branch: "main", instructions: "", created_at: now() };
}

/** GitHub projects linked before v2 have no root_path: point them at their base clone. */
export function backfillRoots(db: Db): void {
  for (const p of db.all("SELECT id, repo FROM projects WHERE kind='github' AND root_path IS NULL")) db.update("projects", p.id, { root_path: repoDirFor(p.repo) });
}
