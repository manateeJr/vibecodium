import { readFile } from 'node:fs/promises';
import type { SubstrateClient, SubstrateSessionState } from '../contracts/substrate-contract.js';
import { isSubstrateSessionLive } from './relaunch-liveness.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_REAPER_INTERVAL_MS = 60 * 1000;
export const DEFAULT_MEMORY_PRESSURE_MIN_MB = 2048;

const MEM_AVAILABLE_PATTERN = /^\s*MemAvailable:\s*(\d+)\s*kB\s*$/im;

export type SessionReapReason = 'reaped' | 'reaped-pressure' | 'liveness-sweep';

export interface SessionReapCandidate {
  readonly sessionId: string;
  readonly substrateName: string;
  readonly idle: boolean;
  readonly lastActivityAt: number;
  readonly runningTurn?: boolean;
}

export interface SessionLivenessCandidate {
  readonly sessionId: string;
  readonly state?: SubstrateSessionState;
  readonly substrateName: string;
}

export interface SessionIdleReaperOptions {
  readonly substrate: SubstrateClient;
  readonly candidates: () => readonly SessionReapCandidate[];
  readonly onReaped: (
    candidate: SessionReapCandidate,
    reason: SessionReapReason,
  ) => void | Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly memoryPressureMinMb?: number;
  readonly memoryAvailableMb?: () => number | Promise<number | undefined>;
  readonly livenessCandidates?: () => readonly SessionLivenessCandidate[];
  readonly onLivenessLost?: (candidate: SessionLivenessCandidate) => void | Promise<void>;
}

export function idleTimeoutMsFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = environment.VIBECODIUM_IDLE_TIMEOUT_MS;
  if (value === undefined || value.trim() === '') return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

export function memoryPressureMinMbFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = environment.VIBECODIUM_MEMORY_PRESSURE_MIN_MB;
  if (value === undefined || value.trim() === '') return DEFAULT_MEMORY_PRESSURE_MIN_MB;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MEMORY_PRESSURE_MIN_MB;
}

export function parseMemAvailableMb(contents: string): number | undefined {
  const match = MEM_AVAILABLE_PATTERN.exec(contents);
  if (!match) return undefined;
  const kilobytes = Number(match[1]);
  return Number.isFinite(kilobytes) ? kilobytes / 1024 : undefined;
}

export async function readMemAvailableMb(): Promise<number | undefined> {
  try {
    return parseMemAvailableMb(await readFile('/proc/meminfo', 'utf8'));
  } catch {
    return undefined;
  }
}

export function pressureReapCandidates(
  candidates: readonly SessionReapCandidate[],
  now: number,
): readonly SessionReapCandidate[] {
  return candidates
    .filter((candidate) => candidate.idle && candidate.runningTurn !== true)
    .sort((left, right) => {
      const leftIdleMs = now - left.lastActivityAt;
      const rightIdleMs = now - right.lastActivityAt;
      const idleDifference = rightIdleMs - leftIdleMs;
      return idleDifference === 0 ? left.sessionId.localeCompare(right.sessionId) : idleDifference;
    });
}

export class SessionIdleReaper {
  private readonly substrate: SubstrateClient;
  private readonly candidates: () => readonly SessionReapCandidate[];
  private readonly onReaped: SessionIdleReaperOptions['onReaped'];
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly memoryPressureMinMb: number;
  private readonly memoryAvailableMb: () => number | Promise<number | undefined>;
  private readonly livenessCandidates: (() => readonly SessionLivenessCandidate[]) | undefined;
  private readonly onLivenessLost: SessionIdleReaperOptions['onLivenessLost'];
  private timer: NodeJS.Timeout | undefined;
  private runPromise: Promise<readonly string[]> | undefined;

  public constructor(options: SessionIdleReaperOptions) {
    this.substrate = options.substrate;
    this.candidates = options.candidates;
    this.onReaped = options.onReaped;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? idleTimeoutMsFromEnv();
    this.intervalMs = options.intervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
    this.memoryPressureMinMb = options.memoryPressureMinMb ?? memoryPressureMinMbFromEnv();
    this.memoryAvailableMb = options.memoryAvailableMb ?? readMemAvailableMb;
    this.livenessCandidates = options.livenessCandidates;
    this.onLivenessLost = options.onLivenessLost;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new Error('idle timeout must be a non-negative finite number');
    }
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('reaper interval must be a positive finite number');
    }
    if (!Number.isFinite(this.memoryPressureMinMb) || this.memoryPressureMinMb < 0) {
      throw new Error('memory pressure threshold must be a non-negative finite number');
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
    const reaped = [...(await this.sweepLiveness())];
    const reapedIds = new Set(reaped);
    const attemptedPressure = new Set<string>();

    if (this.memoryPressureMinMb > 0) {
      let available = await this.memoryAvailableMb();
      while (available !== undefined && available < this.memoryPressureMinMb) {
        const candidate = pressureReapCandidates(this.candidates(), this.now()).find(
          (entry) => !attemptedPressure.has(entry.sessionId),
        );
        if (!candidate) break;
        attemptedPressure.add(candidate.sessionId);
        if (await this.reapCandidate(candidate, 'reaped-pressure')) {
          reaped.push(candidate.sessionId);
          reapedIds.add(candidate.sessionId);
        }
        available = await this.memoryAvailableMb();
      }
    }

    const now = this.now();
    for (const candidate of this.candidates()) {
      if (
        reapedIds.has(candidate.sessionId) ||
        !candidate.idle ||
        candidate.runningTurn === true ||
        now - candidate.lastActivityAt < this.timeoutMs
      )
        continue;
      if (await this.reapCandidate(candidate, 'reaped')) {
        reaped.push(candidate.sessionId);
        reapedIds.add(candidate.sessionId);
      }
    }
    return reaped;
  }

  private async sweepLiveness(): Promise<readonly string[]> {
    const candidates = this.livenessCandidates;
    const onLivenessLost = this.onLivenessLost;
    if (!candidates || !onLivenessLost) return [];
    const swept: string[] = [];
    for (const candidate of candidates()) {
      if (candidate.state !== undefined && candidate.state !== 'live') continue;
      if (await isSubstrateSessionLive(this.substrate, candidate.substrateName)) continue;
      try {
        await this.substrate.kill(candidate.substrateName);
        await onLivenessLost(candidate);
        swept.push(candidate.sessionId);
      } catch {
        // Keep the record live and retry on the next sweep if cleanup fails.
      }
    }
    return swept;
  }

  private async reapCandidate(
    candidate: SessionReapCandidate,
    reason: SessionReapReason,
  ): Promise<boolean> {
    const current = this.candidates().find((entry) => entry.sessionId === candidate.sessionId);
    if (!current || !current.idle || current.runningTurn === true) return false;
    try {
      await this.substrate.kill(current.substrateName);
      await this.onReaped(current, reason);
      return true;
    } catch {
      // Keep the live session and retry on the next sweep if substrate kill fails.
      return false;
    }
  }
}
