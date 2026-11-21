/** Global concurrency cap: at most `cap` agents run at once; the rest wait in a FIFO queue. */
export class Scheduler {
  private running = new Set<string>();
  private queue: string[] = [];
  constructor(public cap = 3) {}

  get size(): number {
    return this.running.size;
  }
  has(id: string): boolean {
    return this.running.has(id);
  }
  /** Acquire a slot without queueing. */
  tryAcquire(id: string): boolean {
    if (this.running.has(id)) return false;
    if (this.running.size >= this.cap) return false;
    this.running.add(id);
    return true;
  }
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
  /** Release a slot; returns the next queued agent that may start, if any. */
  release(agentId: string): string | undefined {
    this.running.delete(agentId);
    this.queue = this.queue.filter((a) => a !== agentId);
    if (this.running.size >= this.cap) return undefined;
    const next = this.queue.shift();
    if (next) this.running.add(next);
    return next;
  }
}
