export type ProbeStatus = 'healthy' | 'degraded' | 'wedged';

export interface ProbeResult {
  readonly status: ProbeStatus;
  readonly detail?: string;
  readonly metrics?: Record<string, number | string>;
}
export type ProbeFunction = () => ProbeResult | Promise<ProbeResult>;

export interface ProbeRegistrationOptions {
  readonly timeoutMs?: number;
}

export interface ProbeObservation extends ProbeResult {
  readonly name: string;
  readonly checkedAt: number;
  readonly durationMs: number;
}

export interface ProbeRun {
  readonly status: ProbeStatus;
  readonly probes: readonly ProbeObservation[];
}
