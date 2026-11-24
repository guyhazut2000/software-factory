import { Button, Input, Label, Select, Textarea } from "./ui";
import type { Agent } from "../lib/types";

const MODELS: Record<string, string[]> = { "claude-code": ["sonnet", "opus", "haiku"], codex: ["gpt-5-codex", "gpt-5"], cursor: ["auto", "sonnet-4.5", "gpt-5"] };
const PERMS = ["advise", "open_pr", "review", "merge", "create_issue"];
const SKILLS = ["implement-issue", "write-tests", "plan-feature", "code-review", "security-review"];
const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** The agent profile editor, shared by the Agents page dialog and the agent drawer's Settings tab. */
export function AgentForm({ value, onChange, onSave, onCancel }: { value: Partial<Agent>; onChange: (v: Partial<Agent>) => void; onSave: () => void; onCancel: () => void }) {
  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => onChange({ ...value, [k]: v });
  return (
          <div className="grid gap-3">
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Name</Label><Input value={value.name ?? ""} onChange={(e) => set("name", e.target.value)} /></div>
              <div><Label>Role</Label><Input list="roles" value={value.role ?? ""} onChange={(e) => set("role", e.target.value)} /><datalist id="roles"><option>chief</option><option>developer</option><option>reviewer</option></datalist></div>
              <div><Label>Effort</Label><Select value={value.effort} onChange={(e) => set("effort", e.target.value)}><option>low</option><option>medium</option><option>high</option></Select></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Provider</Label><Select value={value.provider} onChange={(e) => { onChange({ ...value, provider: e.target.value, model: MODELS[e.target.value][0] }); }}><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="cursor">Cursor Agent</option></Select></div>
              <div className="col-span-2"><Label hint="(run the CLI's model list to see valid names)">Model</Label><Input list="models" value={value.model ?? ""} onChange={(e) => set("model", e.target.value)} /><datalist id="models">{(MODELS[value.provider ?? "claude-code"] ?? []).map((m) => <option key={m}>{m}</option>)}</datalist></div>
            </div>
            <div><Label hint="(becomes the system prompt)">Description</Label><Textarea rows={4} value={value.description ?? ""} onChange={(e) => set("description", e.target.value)} /></div>
            <div><Label hint="(role file: appended to the system prompt on every run; keep it short)">Role instructions</Label><Textarea rows={6} placeholder="e.g. Prefer small PRs. Always add a unit test. Never touch infra/." value={value.instructions ?? ""} onChange={(e) => set("instructions", e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label hint="(comma separated)">Instruction files</Label><Input placeholder="AGENTS.md, CLAUDE.md" value={(value.context?.files ?? []).join(", ")} onChange={(e) => set("context", { ...value.context, files: csv(e.target.value) })} /></div>
              <div><Label hint="(comma separated, empty = whole repo)">Allowed paths</Label><Input placeholder="src/, tests/" value={(value.context?.allowed_paths ?? []).join(", ")} onChange={(e) => set("context", { ...value.context, allowed_paths: csv(e.target.value) })} /></div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div><Label>History size</Label><Input type="number" value={value.context?.history_size ?? 12} onChange={(e) => set("context", { ...value.context, history_size: Number(e.target.value) })} /></div>
              <div><Label hint="(tokens/day)">Token budget</Label><Input type="number" placeholder="unlimited" value={value.token_budget ?? ""} onChange={(e) => set("token_budget", e.target.value ? Number(e.target.value) : null)} /></div>
              <div><Label>Max runtime (s)</Label><Input type="number" value={value.max_runtime_sec ?? 1800} onChange={(e) => set("max_runtime_sec", Number(e.target.value))} /></div>
              <div className="grid grid-cols-2 gap-2"><div><Label>CPU</Label><Input type="number" value={value.cpu ?? 2} onChange={(e) => set("cpu", Number(e.target.value))} /></div><div><Label>RAM MB</Label><Input type="number" value={value.ram_mb ?? 4096} onChange={(e) => set("ram_mb", Number(e.target.value))} /></div></div>
            </div>
            <div>
              <Label>Permissions</Label>
              <div className="flex flex-wrap gap-3">{PERMS.map((p) => <label key={p} className="flex cursor-pointer items-center gap-1.5 text-sm"><input type="checkbox" checked={value.permissions?.includes(p) ?? false} onChange={(e) => set("permissions", e.target.checked ? [...(value.permissions ?? []), p] : (value.permissions ?? []).filter((x) => x !== p))} />{p}</label>)}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label hint="(comma separated, added to role defaults)">Skills / tags</Label><Input list="skills" value={(value.skills ?? []).join(", ")} onChange={(e) => set("skills", csv(e.target.value))} /><datalist id="skills">{SKILLS.map((s) => <option key={s}>{s}</option>)}</datalist></div>
              <div><Label hint="(factory MCP is always on; extra servers cost tokens)">MCP servers</Label>
                <div className="flex gap-4 pt-2 text-sm">
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!value.mcp?.github} onChange={(e) => set("mcp", { ...value.mcp, github: e.target.checked })} />GitHub</label>
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!value.mcp?.filesystem} onChange={(e) => set("mcp", { ...value.mcp, filesystem: e.target.checked })} />Filesystem</label>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onCancel()}>Cancel</Button><Button onClick={onSave} disabled={!value.name}>Save</Button></div>
          </div>
  );
}
