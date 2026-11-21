/** Global concurrency cap: at most `cap` agents run at once; the rest wait in a FIFO queue. */
export class Scheduler {
  private running = new Set<string>();
  private queue: string[] = [];
  constructor(public cap = 3) {}

  /** Returns true if the agent may start now, otherwise queues it. */
  request(agentId: string): boolean {
    if (this.running.has(agentId)) return true;
    if (this.running.size < this.cap) {
      this.running.add(agentId);
      return true;
    }
    if (!this.queue.includes(agentId)) this.queue.push(agentId);
    return false;
  }

  /** Release a slot; returns the next agent that may start, if any. */
  release(agentId: string): string | undefined {
    this.running.delete(agentId);
    this.queue = this.queue.filter((a) => a !== agentId);
    const next = this.queue.shift();
    if (next) this.running.add(next);
    return next;
  }
}
