import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { Server } from 'node:http';
import type { EventStore } from './event-store.js';
import {
  EVENT_LOOP_RESOLUTION_MS,
  eventLoopMetrics,
  registerCoreProbes,
  type EventLoopMetrics,
} from './core-probes.js';
import { writeHeartbeatFile } from './heartbeat.js';
import { ProbeRunner } from './probe-runner.js';
import type { ProbeFunction, ProbeRegistrationOptions, ProbeRun } from '../contracts/probe.js';
import type { SubsystemContext } from '../contracts/subsystem.js';

const HEARTBEAT_INTERVAL_MS = 5_000;

export interface ObservabilityOptions {
  readonly dataPath: string;
  readonly eventStore: EventStore;
  readonly httpServer: () => Server | undefined;
}

export class Observability {
  public readonly eventLoop: IntervalHistogram;
  private readonly dataPath: string;
  private readonly heartbeatEnabled: boolean;
  private readonly probeRunner = new ProbeRunner();
  private cachedProbeRun: ProbeRun = { status: 'healthy', probes: [] };
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatInFlight = false;
  public constructor(options: ObservabilityOptions) {
    this.dataPath = options.dataPath;
    this.heartbeatEnabled = options.dataPath !== ':memory:';
    this.eventLoop = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
    this.eventLoop.enable();
    this.options = options;
  }

  private readonly options: ObservabilityOptions;

  public registerProbe(name: string, fn: ProbeFunction, options?: ProbeRegistrationOptions): void {
    this.probeRunner.register(name, fn, options);
  }

  public registerCoreProbes(context: SubsystemContext): void {
    registerCoreProbes({
      context,
      eventStore: this.options.eventStore,
      eventLoop: this.eventLoop,
      httpServer: this.options.httpServer,
    });
  }

  public async runProbes(target?: string): Promise<ProbeRun> {
    const result = await this.probeRunner.run(target);
    if (target === undefined) this.cachedProbeRun = result;
    return result;
  }
  public startHeartbeat(): void {
    if (!this.heartbeatEnabled || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.refreshHeartbeat().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    void this.refreshHeartbeat().catch(() => undefined);
  }

  public stopHeartbeat(): void {
    const timer = this.heartbeatTimer;
    this.heartbeatTimer = undefined;
    if (timer) clearInterval(timer);
    this.eventLoop.disable();
  }

  private async refreshHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const probes = await this.runProbes();
      writeHeartbeatFile(this.dataPath, this.safeEventLoopMetrics(), probes);
    } catch {
      writeHeartbeatFile(this.dataPath, this.safeEventLoopMetrics(), this.cachedProbeRun);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private safeEventLoopMetrics(): EventLoopMetrics {
    try {
      return eventLoopMetrics(this.eventLoop);
    } catch {
      return { meanMs: 0, maxMs: 0, p99Ms: 0 };
    }
  }
}
