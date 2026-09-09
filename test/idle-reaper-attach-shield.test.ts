import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SubstrateClient } from '../src/contracts/substrate-contract.js';
import {
  SessionIdleReaper,
  pressureReapCandidates,
  type AttachLeaseShield,
  type SessionReapCandidate,
} from '../src/session/idle-reaper.js';
import { PersistentSessionManager } from '../src/session/persistent-session-manager.js';
import { SessionTable } from '../src/session/session-table.js';

/** In-memory fake with the contract's TTL semantics: leased while until > now. */
class FakeAttachLeases implements AttachLeaseShield {
  private readonly leases = new Map<string, number>();
  public pruneCalls = 0;

  public heartbeat(sessionId: string, ttlMs: number, nowMs: number): number {
    const until = nowMs + ttlMs;
    this.leases.set(sessionId, until);
    return until;
  }

  public release(sessionId: string): void {
    this.leases.delete(sessionId);
  }

  public isLeased(sessionId: string, nowMs: number): boolean {
    return (this.leases.get(sessionId) ?? Number.NEGATIVE_INFINITY) > nowMs;
  }

  public prune(nowMs: number): number {
    this.pruneCalls += 1;
    let removed = 0;
    for (const [sessionId, until] of this.leases) {
      if (until <= nowMs) {
        this.leases.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }
}

function candidate(
  sessionId: string,
  lastActivityAt: number,
  options: { idle: boolean; runningTurn?: boolean } = { idle: true },
): SessionReapCandidate {
  return {
    sessionId,
    substrateName: `substrate-${sessionId}`,
    lastActivityAt,
    ...options,
  };
}

test('timeout loop skips leased sessions and reaps them after expiry', async () => {
  let nowMs = 1_000_000;
  const leases = new FakeAttachLeases();
  leases.heartbeat('shielded', 30_000, nowMs);
  const candidates = [candidate('shielded', 0), candidate('free', 0)];
  const killed: string[] = [];
  const reaper = new SessionIdleReaper({
    substrate: {
      kill: async (name: string) => {
        killed.push(name);
      },
    } as SubstrateClient,
    candidates: () => candidates,
    // Mirror production finishReap: a reaped session leaves the candidate set.
    onReaped: (entry) => {
      const index = candidates.findIndex((item) => item.sessionId === entry.sessionId);
      if (index >= 0) candidates.splice(index, 1);
    },
    now: () => nowMs,
    timeoutMs: 60_000,
    memoryPressureMinMb: 0,
    isShielded: (sessionId) => leases.isLeased(sessionId, nowMs),
  });

  assert.deepEqual(await reaper.runOnce(), ['free']);
  assert.deepEqual(killed, ['substrate-free']);

  nowMs += 30_001;
  assert.deepEqual(await reaper.runOnce(), ['shielded']);
  assert.deepEqual(killed, ['substrate-free', 'substrate-shielded']);
});

test('pressure loop skips leased sessions while the selector stays pure', async () => {
  const nowMs = 1_000_000;
  const leases = new FakeAttachLeases();
  leases.heartbeat('oldest', 30_000, nowMs);
  const candidates = [candidate('newest', 800_000), candidate('oldest', 100_000)];
  assert.deepEqual(
    pressureReapCandidates(candidates, nowMs).map((entry) => entry.sessionId),
    ['oldest', 'newest'],
  );
  const killed: string[] = [];
  const available = [100, 2_048];
  const reaper = new SessionIdleReaper({
    substrate: {
      kill: async (name: string) => {
        killed.push(name);
      },
    } as SubstrateClient,
    candidates: () => candidates,
    onReaped: () => undefined,
    now: () => nowMs,
    timeoutMs: Number.MAX_SAFE_INTEGER,
    memoryPressureMinMb: 2_048,
    memoryAvailableMb: () => available.shift() ?? 2_048,
    isShielded: (sessionId) => leases.isLeased(sessionId, nowMs),
  });

  assert.deepEqual(await reaper.runOnce(), ['newest']);
  assert.deepEqual(killed, ['substrate-newest']);
});

test('liveness sweep skips leased sessions and retries after release', async () => {
  const nowMs = 1_000_000;
  const leases = new FakeAttachLeases();
  leases.heartbeat('attached', 30_000, nowMs);
  const killed: string[] = [];
  const swept: string[] = [];
  const liveness = [
    { sessionId: 'attached', substrateName: 'substrate-attached', state: 'live' as const },
    { sessionId: 'orphan', substrateName: 'substrate-orphan', state: 'live' as const },
  ];
  const reaper = new SessionIdleReaper({
    substrate: {
      kill: async (name: string) => {
        killed.push(name);
      },
      listSessions: async () => [],
    } as unknown as SubstrateClient,
    candidates: () => [],
    onReaped: () => undefined,
    now: () => nowMs,
    timeoutMs: Number.MAX_SAFE_INTEGER,
    memoryPressureMinMb: 0,
    livenessCandidates: () => liveness,
    // Mirror production finishReap: a swept record turns resumable and leaves.
    onLivenessLost: (entry) => {
      swept.push(entry.sessionId);
      const index = liveness.findIndex((item) => item.sessionId === entry.sessionId);
      if (index >= 0) liveness.splice(index, 1);
    },
    isShielded: (sessionId) => leases.isLeased(sessionId, nowMs),
  });

  assert.deepEqual(await reaper.runOnce(), ['orphan']);
  assert.deepEqual(killed, ['substrate-orphan']);
  assert.deepEqual(swept, ['orphan']);

  leases.release('attached');
  assert.deepEqual(await reaper.runOnce(), ['attached']);
  assert.deepEqual(killed, ['substrate-orphan', 'substrate-attached']);
  assert.deepEqual(swept, ['orphan', 'attached']);
});

test('manager prunes leases on runReaper and shields leased records', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-reaper-shield-'));
  const table = new SessionTable({ filename: ':memory:' });
  const killed: string[] = [];
  const substrate = {
    kill: async (name: string) => {
      killed.push(name);
    },
    listSessions: async () => [],
    isLive: async () => false,
  } as unknown as SubstrateClient;
  const leases = new FakeAttachLeases();
  table.upsert({
    sessionId: 'attached',
    provider: 'omp',
    harnessRef: 'attached-ref',
    substrateName: 'substrate-attached',
    transcriptPath: path.join(root, 'attached', 'session.jsonl'),
    storageDir: path.join(root, 'attached'),
    state: 'live',
    label: '',
    origin: 'agent',
    updatedAt: new Date(0).toISOString(),
  });
  const manager = new PersistentSessionManager({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    sessionStorageDirs: new Map(),
    append: () => 0,
    summaryFor: () => undefined,
    onStateChange: () => undefined,
    memoryPressureMinMb: 0,
    reaperIntervalMs: 60_000,
    attachLeases: leases,
  });
  try {
    leases.heartbeat('attached', 30_000, Date.now());
    assert.deepEqual(await manager.runReaper(), []);
    assert.equal(leases.pruneCalls, 1);
    assert.equal(table.get('attached')?.state, 'live');
    assert.deepEqual(killed, []);

    leases.heartbeat('attached', -1, Date.now());
    assert.deepEqual(await manager.runReaper(), ['attached']);
    assert.equal(leases.pruneCalls, 2);
    assert.equal(table.get('attached')?.state, 'resumable');
    assert.deepEqual(killed, ['substrate-attached']);
  } finally {
    await manager.shutdown();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
