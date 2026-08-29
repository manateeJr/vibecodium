import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_CONCURRENT = 3;
const HOST_CONFIG_PATH_ENV = 'VIBECODIUM_HOST_CONFIG_PATH';

interface SessionCapCache {
  readonly configPath: string;
  readonly mtimeMs: number | undefined;
  readonly maxConcurrent: number | undefined;
}

let sessionCapCache: SessionCapCache | undefined;

export function hostConfigPath(env?: NodeJS.ProcessEnv): string {
  return (
    (env ?? process.env)[HOST_CONFIG_PATH_ENV] ??
    path.join(os.homedir(), '.vibecodium', 'host-config.json')
  );
}

export function persistedMaxConcurrent(env?: NodeJS.ProcessEnv): number | undefined {
  const configPath = hostConfigPath(env);
  let mtimeMs: number;
  try {
    const stats = statSync(configPath);
    if (!stats.isFile()) throw new Error('host config is not a file');
    mtimeMs = stats.mtimeMs;
  } catch {
    sessionCapCache = { configPath, mtimeMs: undefined, maxConcurrent: undefined };
    return undefined;
  }

  if (sessionCapCache?.configPath === configPath && sessionCapCache.mtimeMs === mtimeMs) {
    return sessionCapCache.maxConcurrent;
  }

  let maxConcurrent: number | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    const config =
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'max_concurrent' in parsed
        ? parsed
        : undefined;
    if (config && isPositiveInteger(config.max_concurrent)) maxConcurrent = config.max_concurrent;
  } catch {
    maxConcurrent = undefined;
  }
  sessionCapCache = { configPath, mtimeMs, maxConcurrent };
  return maxConcurrent;
}

export function effectiveMaxConcurrent(
  configuredMaxConcurrent: number,
  env?: NodeJS.ProcessEnv,
): number {
  return persistedMaxConcurrent(env) ?? configuredMaxConcurrent;
}

export function persistMaxConcurrent(maxConcurrent: number, env?: NodeJS.ProcessEnv): void {
  if (!isPositiveInteger(maxConcurrent))
    throw new Error('max_concurrent must be a positive integer');
  const configPath = hostConfigPath(env);
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(configPath), { recursive: true });
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ max_concurrent: maxConcurrent }, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    renameSync(temporaryPath, configPath);
    sessionCapCache = undefined;
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file was renamed or could not be created.
    }
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

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
  private readonly configuredMaxConcurrent: number;
  private readonly rateMax: number;
  private readonly rateWindowMs: number;
  private readonly now: () => number;
  private readonly admittedAt: number[] = [];

  public constructor(config: AdmissionConfig) {
    this.configuredMaxConcurrent = config.maxConcurrent;
    this.rateMax = config.rateMax;
    this.rateWindowMs = config.rateWindowMs;
    this.now = config.now ?? Date.now;
  }

  public tryAdmit(activeCount: number): AdmissionDecision {
    const maxConcurrent = effectiveMaxConcurrent(this.configuredMaxConcurrent);
    if (activeCount >= maxConcurrent)
      return { ok: false, reason: 'concurrency', limit: maxConcurrent };

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
    maxConcurrent:
      Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : DEFAULT_MAX_CONCURRENT,
    rateMax: Number.isFinite(rateMax) && rateMax > 0 ? rateMax : 20,
    rateWindowMs: Number.isFinite(rateWindowMs) && rateWindowMs > 0 ? rateWindowMs : 60000,
  };
}
