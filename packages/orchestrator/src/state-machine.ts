export type AgentState = "off" | "idle" | "working" | "waiting_for_guy" | "stuck" | "restarting";
export type AgentTrigger = "enable" | "disable" | "assign" | "finish" | "ask" | "answer" | "stall" | "restart" | "restarted";

const table: Record<AgentState, Partial<Record<AgentTrigger, AgentState>>> = {
  off: { enable: "idle" },
  idle: { disable: "off", assign: "working" },
  working: { disable: "off", finish: "idle", ask: "waiting_for_guy", stall: "stuck", restart: "restarting" },
  waiting_for_guy: { answer: "working", disable: "off" },
  stuck: { restart: "restarting", disable: "off" },
  restarting: { restarted: "working", disable: "off" },
};

export function transition(state: AgentState, trigger: AgentTrigger): AgentState {
  const next = table[state][trigger];
  if (!next) throw new Error(`Invalid transition: ${state} --${trigger}-->`);
  return next;
}
