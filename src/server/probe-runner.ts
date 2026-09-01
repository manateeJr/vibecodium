import { performance } from 'node:perf_hooks';
import type {
  ProbeFunction,
  ProbeObservation,
  ProbeRegistrationOptions,
  ProbeResult,
  ProbeRun,
  ProbeStatus,
} from '../contracts/probe.js';

export const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

interface ProbeRegistration {
  readonly fn: ProbeFunction;
  readonly timeoutMs: number;
}

export class ProbeRunner {
  private readonly registrations = new Map<string, ProbeRegistration>();

  public register(name: string, fn: ProbeFunction, options: ProbeRegistrationOptions = {}): void {
    if (!name.trim()) throw new Error('probe name is required');
    if (this.registrations.has(name)) throw new Error(`duplicate probe registration: ${name}`);
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error('probe timeout must be a positive number');
    this.registrations.set(name, { fn, timeoutMs });
  }

  public async run(target?: string): Promise<ProbeRun> {
    const selected = target === undefined ? [...this.registrations] : this.registrationFor(target);
    const probes = await Promise.all(
      selected.map(([name, registration]) => this.runOne(name, registration)),
    );
    return { status: aggregateProbeStatus(probes.map((probe) => probe.status)), probes };
  }

  private registrationFor(target: string): [string, ProbeRegistration][] {
    const registration = this.registrations.get(target);
    if (!registration) throw new Error(`unknown probe: ${target}`);
    return [[target, registration]];
  }

  private async runOne(name: string, registration: ProbeRegistration): Promise<ProbeObservation> {
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    let result: ProbeResult;
    try {
      const timeout = new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'wedged', detail: 'probe timeout' }),
          registration.timeoutMs,
        );
      });
      result = await Promise.race([Promise.resolve().then(registration.fn), timeout]);
      if (!isProbeResult(result)) result = { status: 'degraded', detail: 'invalid probe result' };
    } catch (error: unknown) {
      result = {
        status: 'degraded',
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
    const durationMs = Math.max(0, Math.round((performance.now() - startedAt) * 1_000) / 1_000);
    return {
      ...result,
      name,
      checkedAt: Date.now(),
      durationMs,
    };
  }
}

export function aggregateProbeStatus(statuses: readonly ProbeStatus[]): ProbeStatus {
  let worst: ProbeStatus = 'healthy';
  for (const status of statuses) {
    if (statusRank(status) > statusRank(worst)) worst = status;
  }
  return worst;
}

function statusRank(status: ProbeStatus): number {
  return status === 'wedged' ? 2 : status === 'degraded' ? 1 : 0;
}
function isProbeResult(value: unknown): value is ProbeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('status' in value))
    return false;
  const status = value.status;
  return status === 'healthy' || status === 'degraded' || status === 'wedged';
}
