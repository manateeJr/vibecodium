import assert from 'node:assert/strict';
import test from 'node:test';
import type { SubstrateClient } from '../src/contracts/substrate-contract.js';
import {
  DEFAULT_MEMORY_PRESSURE_MIN_MB,
  DEFAULT_IDLE_TIMEOUT_MS,
  SessionIdleReaper,
  idleTimeoutMsFromEnv,
  memoryPressureMinMbFromEnv,
  parseMemAvailableMb,
  pressureReapCandidates,
  type SessionReapCandidate,
} from '../src/session/idle-reaper.js';

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

test('reaper environment knobs parse valid values and reject malformed values', () => {
  assert.equal(idleTimeoutMsFromEnv({}), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(idleTimeoutMsFromEnv({ VIBECODIUM_IDLE_TIMEOUT_MS: '1250' }), 1250);
  assert.equal(idleTimeoutMsFromEnv({ VIBECODIUM_IDLE_TIMEOUT_MS: '-1' }), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(memoryPressureMinMbFromEnv({}), DEFAULT_MEMORY_PRESSURE_MIN_MB);
  assert.equal(memoryPressureMinMbFromEnv({ VIBECODIUM_MEMORY_PRESSURE_MIN_MB: '0' }), 0);
  assert.equal(memoryPressureMinMbFromEnv({ VIBECODIUM_MEMORY_PRESSURE_MIN_MB: '1536.5' }), 1536.5);
  assert.equal(
    memoryPressureMinMbFromEnv({ VIBECODIUM_MEMORY_PRESSURE_MIN_MB: 'not-a-number' }),
    DEFAULT_MEMORY_PRESSURE_MIN_MB,
  );
});

test('MemAvailable parser converts proc kB to MB', () => {
  assert.equal(parseMemAvailableMb('MemTotal:       100000 kB\nMemAvailable:    204800 kB\n'), 200);
  assert.equal(parseMemAvailableMb('MemTotal: 100000 kB\n'), undefined);
});

test('pressure candidates order by idle duration and exclude running turns', () => {
  assert.deepEqual(
    pressureReapCandidates(
      [
        candidate('middle', 400),
        candidate('running', 0, { idle: true, runningTurn: true }),
        candidate('oldest', 100),
        candidate('active', 50, { idle: false }),
        candidate('newest', 800),
      ],
      1_000,
    ).map((entry) => entry.sessionId),
    ['oldest', 'middle', 'newest'],
  );
});

test('pressure sweep reaps oldest eligible sessions until memory recovers', async () => {
  const candidates = [
    candidate('newest', 800),
    candidate('running', 0, { idle: true, runningTurn: true }),
    candidate('oldest', 100),
    candidate('middle', 400),
  ];
  const killed: string[] = [];
  const reasons: string[] = [];
  const available = [100, 100, 2_048];
  const reaper = new SessionIdleReaper({
    substrate: {
      kill: async (name: string) => {
        killed.push(name);
      },
    } as SubstrateClient,
    candidates: () => candidates,
    onReaped: (entry, reason) => {
      reasons.push(`${entry.sessionId}:${reason}`);
    },
    now: () => 1_000,
    timeoutMs: Number.MAX_SAFE_INTEGER,
    memoryPressureMinMb: 2_048,
    memoryAvailableMb: () => available.shift() ?? 2_048,
  });

  assert.deepEqual(await reaper.runOnce(), ['oldest', 'middle']);
  assert.deepEqual(killed, ['substrate-oldest', 'substrate-middle']);
  assert.deepEqual(reasons, ['oldest:reaped-pressure', 'middle:reaped-pressure']);
});
