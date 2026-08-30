import type { SubstrateClient } from '../contracts/substrate-contract.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_REAPER_INTERVAL_MS = 60 * 1000;

export interface SessionReapCandidate {
  readonly sessionId: string;
  readonly substrateName: string;
  readonly idle: boolean;
  readonly lastActivityAt: number;
}

export interface SessionIdleReaperOptions {
  readonly substrate: SubstrateClient;
  readonly candidates: () => readonly SessionReapCandidate[];
  readonly onReaped: (candidate: SessionReapCandidate) => void | Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export class SessionIdleReaper {
  private readonly substrate: SubstrateClient;
  private readonly candidates: () => readonly SessionReapCandidate[];
  private readonly onReaped: (candidate: SessionReapCandidate) => void | Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private runPromise: Promise<readonly string[]> | undefined;

  public constructor(options: SessionIdleReaperOptions) {
    this.substrate = options.substrate;
    this.candidates = options.candidates;
    this.onReaped = options.onReaped;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new Error('idle timeout must be a non-negative finite number');
    }
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('reaper interval must be a positive finite number');
    }
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  public runOnce(): Promise<readonly string[]> {
    if (this.runPromise) return this.runPromise;
    const run = this.reapExpired();
    this.runPromise = run.finally(() => {
      if (this.runPromise === tracked) this.runPromise = undefined;
    });
    const tracked = this.runPromise;
    return tracked;
  }

  private async reapExpired(): Promise<readonly string[]> {
    const reaped: string[] = [];
    const now = this.now();
    for (const candidate of this.candidates()) {
      if (!candidate.idle || now - candidate.lastActivityAt < this.timeoutMs) continue;
      try {
        await this.substrate.kill(candidate.substrateName);
        await this.onReaped(candidate);
        reaped.push(candidate.sessionId);
      } catch {
        // Keep the live session and retry on the next sweep if substrate kill fails.
      }
    }
    return reaped;
  }
}
