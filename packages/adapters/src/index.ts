import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import type { ProviderAdapter, ProviderId } from "./types.js";

export * from "./types.js";
export { claudeCodeAdapter, codexAdapter, cursorAdapter };

export const adapters: Record<ProviderId, ProviderAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
};

export function getAdapter(id: string): ProviderAdapter {
  const a = (adapters as Record<string, ProviderAdapter>)[id];
  if (!a) throw new Error(`Unknown provider: ${id}`);
  return a;
}
