import { readFile } from 'node:fs/promises';
import type { SubstrateClient, SubstrateSessionState } from '../contracts/substrate-contract.js';
import { isSubstrateSessionLive } from './relaunch-liveness.js';
import type { SessionAttachLeases } from './session-attach-leases.js';

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
/**
 * Attach-lease shield surface (#118): the canonical `SessionAttachLeases`
 * narrowed to what attach-aware reaping needs — lease check + expiry prune.
 * A canonical `SessionAttachLeases` instance is directly assignable.
 */
export type AttachLeaseShield = Pick<SessionAttachLeases, 'isLeased' | 'prune'>;

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
  /**
   * Attach-lease shield (#118): return true while `sessionId` is held by an
   * attached terminal. Shielded sessions are skipped in the timeout loop, the
   * pressure loop, and the liveness sweep — never killed under lease.
   * Defaults to `() => false` (no shielding; prior behavior).
   */
  readonly isShielded?: (sessionId: string) => boolean;
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
  private readonly isShielded: (sessionId: string) => boolean;
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
    this.isShielded = options.isShielded ?? (() => false);
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
          (entry) => !attemptedPressure.has(entry.sessionId) && !this.isShielded(entry.sessionId),
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
        this.isShielded(candidate.sessionId) ||
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
      // Attach-aware reaping (#118): never kill under an active attach lease —
      // not even on a failed liveness probe. Rationale: substrate death
      // disconnects the terminal (the abduco client exits when the server dies),
      // so the CLI heartbeat stops and the 30s TTL lapses; the next sweep then
      // reconciles. The stale window is bounded (~90s) and self-healing, while
      // killing an attached session on a false-negative probe under load (the
      // wedge dumps seen during gate runs) repeats exactly the complaint #118
      // fixes. Keep this a pure lease check: no freshness sub-checks.
      if (this.isShielded(candidate.sessionId)) continue;
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
    if (this.isShielded(current.sessionId)) return false;
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
