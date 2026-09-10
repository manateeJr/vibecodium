export const TURN_QUEUE_CAP = 5;

export type EnqueueResult = { queued: true; position: number } | { queued: false; reason: 'full' };

export class TurnQueue {
  private readonly queues = new Map<number, string[]>();

  enqueue(threadId: number, prompt: string): EnqueueResult {
    const queue = this.queues.get(threadId) ?? [];
    if (queue.length >= TURN_QUEUE_CAP) return { queued: false, reason: 'full' };
    queue.push(prompt);
    this.queues.set(threadId, queue);
    return { queued: true, position: queue.length };
  }

  dequeue(threadId: number): string | undefined {
    const queue = this.queues.get(threadId);
    if (queue === undefined || queue.length === 0) return undefined;
    const next = queue.shift();
    if (queue.length === 0) this.queues.delete(threadId);
    return next;
  }

  clear(threadId: number): void {
    this.queues.delete(threadId);
  }

  size(threadId: number): number {
    return this.queues.get(threadId)?.length ?? 0;
  }
}
