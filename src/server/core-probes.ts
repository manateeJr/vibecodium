import type { Server } from 'node:http';
import type { IntervalHistogram } from 'node:perf_hooks';
import { errorMessage } from './control-plane-helpers.js';
import type { EventStore } from './event-store.js';
import type { ProbeResult } from '../contracts/probe.js';
import type { SubsystemContext } from '../contracts/subsystem.js';

export const EVENT_LOOP_RESOLUTION_MS = 20;
// Mean delay above 100ms is degraded; above 1s is wedged.
export const EVENT_LOOP_DEGRADED_MEAN_MS = 100;
export const EVENT_LOOP_WEDGED_MEAN_MS = 1_000;

export interface CoreProbeRegistrationOptions {
  readonly context: SubsystemContext;
  readonly eventStore: EventStore;
  readonly eventLoop: IntervalHistogram;
  readonly httpServer: () => Server | undefined;
}

export interface EventLoopMetrics {
  readonly meanMs: number;
  readonly maxMs: number;
  readonly p99Ms: number;
}

export function registerCoreProbes(options: CoreProbeRegistrationOptions): void {
  const registerProbe = options.context.registerProbe;
  if (!registerProbe) return;
  registerProbe('eventloop', () => eventLoopProbe(options.eventLoop));
  registerProbe('eventstore', () => eventStoreProbe(options.eventStore));
  registerProbe('http', () => httpProbe(options.httpServer));
}

export function eventLoopMetrics(histogram: IntervalHistogram): EventLoopMetrics {
  return {
    meanMs: nanosecondsToMs(histogram.mean),
    maxMs: nanosecondsToMs(histogram.max),
    p99Ms: nanosecondsToMs(histogram.percentile(99)),
  };
}

export function eventLoopProbe(histogram: IntervalHistogram): ProbeResult {
  const metrics = eventLoopMetrics(histogram);
  const status =
    metrics.meanMs > EVENT_LOOP_WEDGED_MEAN_MS
      ? 'wedged'
      : metrics.meanMs > EVENT_LOOP_DEGRADED_MEAN_MS
        ? 'degraded'
        : 'healthy';
  return {
    status,
    ...(status === 'healthy' ? {} : { detail: `event loop mean delay ${metrics.meanMs}ms` }),
    metrics: { ...metrics },
  };
}

export function eventStoreProbe(eventStore: EventStore): ProbeResult {
  try {
    return { status: 'healthy', metrics: { ...eventStore.stats() } };
  } catch (error: unknown) {
    return { status: 'degraded', detail: errorMessage(error) };
  }
}

export function httpProbe(getServer: () => Server | undefined): Promise<ProbeResult> {
  const server = getServer();
  if (!server) return Promise.resolve({ status: 'degraded', detail: 'HTTP server is not running' });
  return new Promise((resolve) => {
    try {
      // Node exposes open connections, not the kernel accept-queue depth; this is a proxy.
      server.getConnections((error, connections) => {
        if (error) {
          resolve({ status: 'degraded', detail: errorMessage(error) });
          return;
        }
        resolve({
          status: 'healthy',
          metrics: { connections, uptimeMs: Math.round(process.uptime() * 1_000) },
        });
      });
    } catch (error: unknown) {
      resolve({ status: 'degraded', detail: errorMessage(error) });
    }
  });
}

function nanosecondsToMs(value: number): number {
  return Number.isFinite(value) ? Number((value / 1_000_000).toFixed(3)) : 0;
}
