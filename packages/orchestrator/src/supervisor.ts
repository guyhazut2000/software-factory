import { EDIT_TOOLS } from "@sf/adapters";

export interface SupervisorConfig {
  stuckMs: number; // no events at all
  loopWindow: number; // last N tool calls
  loopRepeats: number; // identical calls in window => loop
  burnTokens: number; // tokens spent since last edit => burn
  maxRestarts: number;
}

export const defaultSupervisorConfig: SupervisorConfig = { stuckMs: 10 * 60_000, loopWindow: 12, loopRepeats: 8, burnTokens: 250_000, maxRestarts: 3 };

interface Track {
  last: number;
  calls: string[];
  tokensSinceEdit: number;
}

export type Verdict = { ok: true } | { ok: false; kind: "stuck" | "loop" | "burn"; reason: string };
export type Escalation = "soft_stop" | "restart" | "stop";

export class Supervisor {
  private runs = new Map<string, Track>();
  constructor(public cfg: SupervisorConfig = defaultSupervisorConfig) {}

  start(runId: string, now: number): void {
    this.runs.set(runId, { last: now, calls: [], tokensSinceEdit: 0 });
  }
  end(runId: string): void {
    this.runs.delete(runId);
  }
  beat(runId: string, now: number, info: { tool?: string; input?: unknown; tokens?: number } = {}): void {
    const t = this.runs.get(runId);
    if (!t) return;
    t.last = now;
    if (info.tool) {
      t.calls.push(`${info.tool}:${JSON.stringify(info.input ?? null).slice(0, 300)}`);
      if (t.calls.length > this.cfg.loopWindow) t.calls.shift();
      if (EDIT_TOOLS.has(info.tool)) t.tokensSinceEdit = 0;
    }
    if (info.tokens) t.tokensSinceEdit += info.tokens;
  }
  check(runId: string, now: number): Verdict {
    const t = this.runs.get(runId);
    if (!t) return { ok: true };
    if (now - t.last > this.cfg.stuckMs) return { ok: false, kind: "stuck", reason: `no activity for ${Math.round((now - t.last) / 60000)} min` };
    const counts = new Map<string, number>();
    for (const c of t.calls) counts.set(c, (counts.get(c) ?? 0) + 1);
    const worst = Math.max(0, ...counts.values());
    if (worst >= this.cfg.loopRepeats) return { ok: false, kind: "loop", reason: `same tool call repeated ${worst} times` };
    if (t.tokensSinceEdit > this.cfg.burnTokens) return { ok: false, kind: "burn", reason: `${t.tokensSinceEdit} tokens spent without any edit` };
    return { ok: true };
  }
  /** Escalation ladder: soft-stop -> restart -> stop + notify. */
  escalate(restartCount: number): Escalation {
    if (restartCount === 0) return "soft_stop";
    if (restartCount < this.cfg.maxRestarts) return "restart";
    return "stop";
  }
}
