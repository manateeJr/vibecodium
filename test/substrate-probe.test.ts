import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProbeFunction } from '../src/contracts/probe.js';
import type { SubsystemContext } from '../src/contracts/subsystem.js';
import type {
  SubstrateClient,
  SubstrateSessionRecord,
  SubstrateSessionState,
} from '../src/contracts/substrate-contract.js';
import { registerSubstrateProbe } from '../src/session/substrate-probe.js';
import type { SessionTable } from '../src/session/session-table.js';

function record(substrateName: string, state: SubstrateSessionState): SubstrateSessionRecord {
  return {
    sessionId: `session-${substrateName}`,
    provider: 'fake',
    harnessRef: 'fake',
    substrateName,
    transcriptPath: '/tmp/fake-transcript.jsonl',
    storageDir: '/tmp/fake-session',
    state,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

test('substrate probe counts only owned live sessions', async () => {
  const ownedLive = record('substrate-owned-live', 'live');
  const ownedDead = record('substrate-owned-dead', 'closed');
  const registryOnly = record('substrate-registry-only', 'live');
  const sessions = [
    { name: ownedLive.substrateName, live: true },
    { name: 'substrate-foreign-live', live: true },
    { name: ownedDead.substrateName, live: false },
  ] as const;
  const substrate = {
    listSessions: async () => sessions,
  } as unknown as SubstrateClient;
  const registrations: Array<{ name: string; fn: ProbeFunction }> = [];
  const context = {
    registerProbe(name: string, fn: ProbeFunction): void {
      registrations.push({ name, fn });
    },
  } as unknown as SubsystemContext;
  const table = (records: readonly SubstrateSessionRecord[]) =>
    ({ list: () => records }) as unknown as SessionTable;

  registerSubstrateProbe(context, substrate, table([ownedLive, ownedDead]));
  const healthyRegistration = registrations.at(-1);
  if (healthyRegistration === undefined) throw new Error('probe was not registered');
  assert.equal(healthyRegistration.name, 'substrate');
  const healthy = await healthyRegistration.fn();
  assert.equal(healthy.status, 'healthy');
  assert.deepEqual(healthy.metrics, { abduco: 1, registry: 1, staleLive: 0 });

  registerSubstrateProbe(context, substrate, table([ownedLive, ownedDead, registryOnly]));
  const degradedRegistration = registrations.at(-1);
  if (degradedRegistration === undefined) throw new Error('probe was not registered');
  const degraded = await degradedRegistration.fn();
  assert.equal(degraded.status, 'degraded');
  assert.deepEqual(degraded.metrics, { abduco: 1, registry: 2, staleLive: 1 });
});

test('a resumable record with a live abduco session is not drift', async () => {
  const resumable = record('substrate-resumable-live', 'resumable');
  const sessions = [{ name: resumable.substrateName, live: true }] as const;
  const substrate = {
    listSessions: async () => sessions,
  } as unknown as SubstrateClient;
  const registrations: Array<{ name: string; fn: ProbeFunction }> = [];
  const context = {
    registerProbe(name: string, fn: ProbeFunction): void {
      registrations.push({ name, fn });
    },
  } as unknown as SubsystemContext;
  const table = (records: readonly SubstrateSessionRecord[]) =>
    ({ list: () => records }) as unknown as SessionTable;

  registerSubstrateProbe(context, substrate, table([resumable]));
  const registration = registrations.at(-1);
  if (registration === undefined) throw new Error('probe was not registered');
  const result = await registration.fn();
  assert.equal(result.status, 'healthy');
  assert.deepEqual(result.metrics, { abduco: 1, registry: 0, staleLive: 0 });
});
