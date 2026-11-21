import { EventEmitter } from "node:events";

export type HubEvent =
  | { type: "agents" | "tasks" | "projects" | "questions" | "messages" | "settings" | "costs" }
  | { type: "log"; run_id: string; task_id: string | null; agent_id: string; kind: string; text: string; ts: number }
  | { type: "notify"; title: string; body: string };

export class Hub extends EventEmitter {
  emitEvent(e: HubEvent): void {
    this.emit("event", e);
  }
}
