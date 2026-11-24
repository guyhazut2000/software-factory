export interface IdeWorkspace { id: string; label: string; kind: "main" | "folder" | "task" | "mine"; exists?: boolean; project_id: string | null; task_id?: string; ref?: string; git: boolean; read_only: boolean; note?: string; show_secrets?: boolean }
export interface Entry { name: string; path: string; type: "dir" | "file" | "symlink" | "submodule"; size?: number; outside?: boolean; secret?: boolean }
export interface FileView { path: string; size: number; language: string; sha256?: string; content?: string; binary?: boolean; too_large?: boolean; masked?: boolean }
export interface Change { path: string; orig_path?: string; staged: string; unstaged: string; untracked?: boolean; conflict?: boolean }
export interface GitStatus { branch: string | null; detached: boolean; ahead: number; behind: number; changes: Change[]; truncated: boolean; pinned?: boolean }
export interface DiffFile { path: string; orig_path?: string; status: string }
export interface Blob { exists: boolean; content?: string; binary?: boolean; too_large?: boolean; masked?: boolean; size?: number }
export interface DiffPair { path: string; orig_path?: string; language: string; label: string; original: Blob; modified: Blob }
export interface Commit { sha: string; author: string; at: number; subject: string }
export type DiffMode = "unstaged" | "staged" | "task";
