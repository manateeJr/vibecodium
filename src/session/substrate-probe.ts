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
      const liveNames = new Set(
        sessions.filter((session) => session.live).map((session) => session.name),
      );
      const abduco = sessions.filter((session) => session.live && owned.has(session.name)).length;
      const registry = records.filter((record) => record.state === 'live').length;
      // Real drift is only a record asserting `live` with no live abduco session. A `resumable`
      // record legitimately has no live session (resumable-from-history) OR a detached-but-live
      // one, and a foreign live session (no owning record) is not ours to reconcile — neither is
      // drift. Counting `state === 'live'` against the abduco total false-positived on every
      // restart, when all sessions detach to `resumable`.
      const staleLive = records.filter(
        (record) => record.state === 'live' && !liveNames.has(record.substrateName),
      ).length;
      if (staleLive === 0) return { status: 'healthy', metrics: { abduco, registry, staleLive } };
      return {
        status: 'degraded',
        detail: `substrate/session registry drift: ${staleLive} record(s) marked live without a live abduco session (abduco=${abduco}, registry=${registry})`,
        metrics: { abduco, registry, staleLive },
      };
    },
    { timeoutMs: 2_000 },
  );
}
