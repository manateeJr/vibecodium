import fs from 'node:fs';
import path from 'node:path';
import type { ProbeRun } from '../contracts/probe.js';
import type { EventLoopMetrics } from './core-probes.js';

export interface HeartbeatSnapshot {
  readonly ts: string;
  readonly uptimeMs: number;
  readonly rss: number;
  readonly heapUsed: number;
  readonly eventloop: EventLoopMetrics;
  readonly probes: ProbeRun;
}

export function writeHeartbeatFile(
  dataPath: string,
  eventloop: EventLoopMetrics,
  probes: ProbeRun,
): void {
  const dataDir = path.dirname(dataPath);
  const temporaryPath = path.join(dataDir, `.heartbeat-${process.pid}.tmp`);
  const memory = process.memoryUsage();
  const snapshot: HeartbeatSnapshot = {
    ts: new Date().toISOString(),
    uptimeMs: Math.round(process.uptime() * 1_000),
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    eventloop,
    probes,
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temporaryPath, path.join(dataDir, 'heartbeat.json'));
  } catch {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Heartbeat is best effort and must never interrupt the control plane.
    }
  }
}
