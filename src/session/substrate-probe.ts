import type { ProbeResult } from '../contracts/probe.js';
import type { SubsystemContext } from '../contracts/subsystem.js';
import type { SubstrateClient } from '../contracts/substrate-contract.js';
import type { SessionTable } from './session-table.js';
import type { PtySubscriptionHub } from './pty-subscriptions.js';

export function registerSessionProbes(
  context: SubsystemContext,
  subscribePty: PtySubscriptionHub['subscribe'],
  substrate: SubstrateClient | undefined,
  sessionTable: SessionTable | undefined,
): void {
  context.registerPtySource?.(subscribePty);
  registerSubstrateProbe(context, substrate, sessionTable);
}

export function registerSubstrateProbe(
  context: SubsystemContext,
  substrate: SubstrateClient | undefined,
  sessionTable: SessionTable | undefined,
): void {
  const registerProbe = context.registerProbe;
  if (!registerProbe) return;
  registerProbe(
    'substrate',
    async (): Promise<ProbeResult> => {
      if (!substrate || !sessionTable)
        return {
          status: 'degraded',
          detail: 'substrate is not configured',
          metrics: { abduco: 0, registry: 0 },
        };
      const [sessions, records] = await Promise.all([
        substrate.listSessions(),
        sessionTable.list(),
      ]);
      const owned = new Set(records.map((record) => record.substrateName));
      const abduco = sessions.filter((session) => session.live && owned.has(session.name)).length;
      const registry = records.filter((record) => record.state === 'live').length;
      if (abduco === registry) return { status: 'healthy', metrics: { abduco, registry } };
      return {
        status: 'degraded',
        detail: `substrate/session registry drift: abduco=${abduco}, registry=${registry}`,
        metrics: { abduco, registry },
      };
    },
    { timeoutMs: 2_000 },
  );
}
