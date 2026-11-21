import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Card } from "../components/ui";
import { fmtTokens } from "../lib/utils";

interface Costs { per_agent: { id: string; name: string; input_tokens: number; output_tokens: number; usd: number }[]; per_day: { day: string; tokens: number; usd: number }[] }

export function Costs() {
  const { logs, state } = useStore();
  const [c, setC] = useState<Costs | null>(null);
  useEffect(() => { api<Costs>("/api/costs").then(setC).catch(() => {}); }, [logs.length]);
  if (!c) return null;
  const max = Math.max(1, ...c.per_day.map((d) => d.tokens ?? 0));
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <h1 className="text-lg font-semibold">Costs</h1>
      <Card className="p-4">
        <div className="mb-3 font-medium">By agent (all time)</div>
        <table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th>Agent</th><th>Input tok</th><th>Output tok</th><th>Est. USD</th><th>Today / budget</th></tr></thead>
          <tbody>{c.per_agent.map((a) => { const ag = state?.agents.find((x) => x.id === a.id); return <tr key={a.id} className="border-t"><td className="py-1.5">{a.name}</td><td>{fmtTokens(a.input_tokens)}</td><td>{fmtTokens(a.output_tokens)}</td><td>${a.usd.toFixed(2)}</td><td>{fmtTokens(ag?.tokens_today ?? 0)} / {ag?.token_budget ? fmtTokens(ag.token_budget) : "unlimited"}</td></tr>; })}</tbody></table>
        <div className="mt-2 text-xs text-muted-foreground">USD is reported by Claude Code only. With a subscription it is a notional estimate, not a bill.</div>
      </Card>
      <Card className="p-4">
        <div className="mb-3 font-medium">Tokens per day</div>
        <div className="grid gap-1.5">{c.per_day.map((d) => <div key={d.day} className="flex items-center gap-2 text-xs"><span className="w-20 text-muted-foreground">{d.day}</span><div className="h-3 rounded bg-primary" style={{ width: `${((d.tokens ?? 0) / max) * 100}%` }} /><span>{fmtTokens(d.tokens ?? 0)}</span></div>)}{c.per_day.length === 0 && <div className="text-muted-foreground">No usage yet.</div>}</div>
      </Card>
    </div>
  );
}
