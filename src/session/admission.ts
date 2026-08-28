export interface AdmissionConfig {
  maxConcurrent: number;
  rateMax: number;
  rateWindowMs: number;
  now?: () => number;
}

export type AdmissionDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'concurrency' | 'rate';
      limit: number;
      retry_after_ms?: number;
    };

type DeniedAdmissionDecision = Extract<AdmissionDecision, { ok: false }>;

export class AdmissionBudget {
  private readonly maxConcurrent: number;
  private readonly rateMax: number;
  private readonly rateWindowMs: number;
  private readonly now: () => number;
  private readonly admittedAt: number[] = [];

  public constructor(config: AdmissionConfig) {
    this.maxConcurrent = config.maxConcurrent;
    this.rateMax = config.rateMax;
    this.rateWindowMs = config.rateWindowMs;
    this.now = config.now ?? Date.now;
  }

  public tryAdmit(activeCount: number): AdmissionDecision {
    if (activeCount >= this.maxConcurrent)
      return { ok: false, reason: 'concurrency', limit: this.maxConcurrent };

    const now = this.now();
    const cutoff = now - this.rateWindowMs;
    while (this.admittedAt.length > 0 && this.admittedAt[0]! < cutoff) this.admittedAt.shift();

    if (this.admittedAt.length >= this.rateMax) {
      const oldestRemaining = this.admittedAt[0] ?? now;
      return {
        ok: false,
        reason: 'rate',
        limit: this.rateMax,
        retry_after_ms: Math.max(0, this.rateWindowMs - (now - oldestRemaining)),
      };
    }

    this.admittedAt.push(now);
    return { ok: true };
  }
}

export class SessionThrottledError extends Error {
  public readonly reason: DeniedAdmissionDecision['reason'];
  public readonly limit: number;
  public readonly retry_after_ms: number | undefined;

  public constructor(decision: DeniedAdmissionDecision) {
    const retry =
      decision.retry_after_ms === undefined
        ? ''
        : `, retry in ${Math.ceil(decision.retry_after_ms / 1000)}s`;
    super(
      decision.reason === 'concurrency'
        ? `session throttled: concurrency limit ${decision.limit} reached`
        : `session throttled: rate limit ${decision.limit}${retry}`,
    );
    this.name = 'SessionThrottledError';
    this.reason = decision.reason;
    this.limit = decision.limit;
    this.retry_after_ms = decision.retry_after_ms;
  }
}

export function admissionConfigFromEnv(env?: NodeJS.ProcessEnv): AdmissionConfig {
  const source = env ?? process.env;
  const maxConcurrent = Number.parseInt(source.VIBECODIUM_MAX_CONCURRENT_SESSIONS ?? '', 10);
  const rateMax = Number.parseInt(source.VIBECODIUM_SESSION_RATE_MAX ?? '', 10);
  const rateWindowMs = Number.parseInt(source.VIBECODIUM_SESSION_RATE_WINDOW_MS ?? '', 10);
  return {
    maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 3,
    rateMax: Number.isFinite(rateMax) && rateMax > 0 ? rateMax : 20,
    rateWindowMs: Number.isFinite(rateWindowMs) && rateWindowMs > 0 ? rateWindowMs : 60000,
  };
}
