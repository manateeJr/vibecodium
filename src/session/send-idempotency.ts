import type { SessionSendResult } from '../contracts/commands.js';

type SendResult = SessionSendResult | Promise<SessionSendResult>;

const IDEMPOTENCY_TTL_MS = 60_000;
const IDEMPOTENCY_MAX_ENTRIES = 1_024;

interface CachedSend {
  readonly expiresAt: number;
  readonly result: Promise<SessionSendResult>;
}

export class SessionSendIdempotency {
  private readonly entries = new Map<string, CachedSend>();
  private readonly now: () => number;

  public constructor(now: () => number) {
    this.now = now;
  }
  public run(
    sessionId: string,
    idempotencyKey: string | undefined,
    send: () => SendResult,
  ): SendResult {
    if (idempotencyKey === undefined) return send();
    const now = this.now();
    this.prune(now);
    const cacheKey = JSON.stringify([sessionId, idempotencyKey]);
    const cached = this.entries.get(cacheKey);
    if (cached !== undefined) return cached.result;
    const result = send();
    this.entries.set(cacheKey, {
      expiresAt: now + IDEMPOTENCY_TTL_MS,
      result: Promise.resolve(result),
    });
    this.trim();
    return result;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private trim(): void {
    while (this.entries.size > IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
