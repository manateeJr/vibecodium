import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { VibecodiumClient } from '../src/client/index.js';
import {
  ATTACH_HEARTBEAT_INTERVAL_MS,
  attachSession,
  type AttachSpawner,
} from '../src/cli-attach.js';

const SESSION_ID = 'session-test';

type LeaseCall = {
  readonly session_id: string;
};

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

function asChildProcess(child: FakeChild): ChildProcess {
  // Test double: attach only touches the EventEmitter surface plus exit/signal codes.
  return child as unknown as ChildProcess;
}

function spawnChild(child: FakeChild): AttachSpawner {
  return () => asChildProcess(child);
}

function fakeLeaseClient(releaseImpl?: () => Promise<{ released: boolean }>): {
  readonly client: VibecodiumClient;
  readonly heartbeatCalls: LeaseCall[];
  readonly releaseCalls: LeaseCall[];
} {
  const heartbeatCalls: LeaseCall[] = [];
  const releaseCalls: LeaseCall[] = [];
  const release = releaseImpl ?? (async () => ({ released: true }));
  const client = {
    sessionAttachInfo: async () => ({
      substrate_name: 'substrate-test',
      abduco_bin_path: '/tmp/abduco',
      state: 'live',
    }),
    sessionEnsureLive: async () => ({ state: 'live', substrate_name: 'substrate-test' }),
    sessionSendKeys: async () => ({}),
    sessionAttachHeartbeat: async (args: LeaseCall) => {
      heartbeatCalls.push(args);
      return { lease_until_ms: Date.now() + 30_000 };
    },
    sessionAttachRelease: async (args: LeaseCall) => {
      releaseCalls.push(args);
      return release();
    },
  } as unknown as VibecodiumClient;
  return { client, heartbeatCalls, releaseCalls };
}

async function flushTasks(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForHeartbeatStart(sigintBaseline: number): Promise<void> {
  for (let index = 0; index < 1000; index += 1) {
    if (process.listeners('SIGINT').length > sigintBaseline) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('attach heartbeat did not start');
}

test('heartbeat fires on interval while attached, then stops and releases on close', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const originalExitCode = process.exitCode;
  const sigintBaseline = process.listeners('SIGINT').length;
  const sigtermBaseline = process.listeners('SIGTERM').length;
  try {
    const { client, heartbeatCalls, releaseCalls } = fakeLeaseClient();
    const child = new FakeChild();
    const pending = attachSession(client, SESSION_ID, spawnChild(child));
    await waitForHeartbeatStart(sigintBaseline);
    assert.equal(heartbeatCalls.length, 0);
    assert.equal(process.listeners('SIGTERM').length, sigtermBaseline + 1);
    t.mock.timers.tick(ATTACH_HEARTBEAT_INTERVAL_MS);
    assert.equal(heartbeatCalls.length, 1);
    assert.deepEqual(heartbeatCalls[0], { session_id: SESSION_ID });
    t.mock.timers.tick(ATTACH_HEARTBEAT_INTERVAL_MS * 2);
    assert.equal(heartbeatCalls.length, 3);
    child.exitCode = 0;
    child.emit('close', 0, null);
    await pending;
    assert.equal(process.exitCode, 0);
    assert.deepEqual(releaseCalls, [{ session_id: SESSION_ID }]);
    t.mock.timers.tick(60_000);
    assert.equal(heartbeatCalls.length, 3);
    assert.equal(process.listeners('SIGINT').length, sigintBaseline);
    assert.equal(process.listeners('SIGTERM').length, sigtermBaseline);
  } finally {
    process.exitCode = originalExitCode;
    t.mock.timers.reset();
  }
});

test('a failing release never breaks detach', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const originalExitCode = process.exitCode;
  try {
    const { client, releaseCalls } = fakeLeaseClient(async () => {
      throw new Error('lease store down');
    });
    const child = new FakeChild();
    const pending = attachSession(client, SESSION_ID, spawnChild(child));
    await flushTasks();
    child.exitCode = 0;
    child.emit('close', 0, null);
    await pending;
    assert.equal(process.exitCode, 0);
    assert.equal(releaseCalls.length, 1);
  } finally {
    process.exitCode = originalExitCode;
    t.mock.timers.reset();
  }
});

test('child error still releases and preserves the original error', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const originalExitCode = process.exitCode;
  try {
    const { client, releaseCalls } = fakeLeaseClient(async () => {
      throw new Error('lease store down');
    });
    const child = new FakeChild();
    const pending = attachSession(client, SESSION_ID, spawnChild(child));
    await flushTasks();
    child.emit('error', new Error('abduco vanished'));
    await assert.rejects(pending, /abduco vanished/);
    assert.equal(releaseCalls.length, 1);
  } finally {
    process.exitCode = originalExitCode;
    t.mock.timers.reset();
  }
});

test('SIGINT releases the lease once and re-raises the signal', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const originalExitCode = process.exitCode;
  // process.kill is stubbed so the test survives the handler's self re-raise.
  const stubbable = process as unknown as { kill: typeof process.kill };
  const originalKill = stubbable.kill;
  const killed: Array<{ readonly pid: number; readonly signal: NodeJS.Signals }> = [];
  stubbable.kill = ((pid: number, signal: NodeJS.Signals) => {
    killed.push({ pid, signal });
    return true;
  }) as typeof process.kill;
  try {
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const { client, heartbeatCalls, releaseCalls } = fakeLeaseClient();
    const child = new FakeChild();
    const pending = attachSession(client, SESSION_ID, spawnChild(child));
    await flushTasks();
    const added = process.listeners('SIGINT').filter((listener) => !sigintBefore.has(listener));
    assert.equal(added.length, 1);
    const before = heartbeatCalls.length;
    t.mock.timers.tick(ATTACH_HEARTBEAT_INTERVAL_MS);
    assert.equal(heartbeatCalls.length, before + 1);
    const handler = added[0] as unknown as () => void;
    handler();
    for (let index = 0; index < 1000; index += 1) {
      if (releaseCalls.length > 0 && killed.length > 0) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(releaseCalls, [{ session_id: SESSION_ID }]);
    assert.equal(killed.length, 1);
    assert.equal(killed[0]?.pid, process.pid);
    assert.equal(killed[0]?.signal, 'SIGINT');
    t.mock.timers.tick(60_000);
    assert.equal(heartbeatCalls.length, before + 1);
    child.exitCode = 0;
    child.emit('close', 0, null);
    await pending;
    assert.equal(releaseCalls.length, 1);
  } finally {
    stubbable.kill = originalKill;
    process.exitCode = originalExitCode;
    t.mock.timers.reset();
  }
});

test('attach works when lease methods are absent (pre-Lane-A client)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const originalExitCode = process.exitCode;
  try {
    const client = {
      sessionAttachInfo: async () => ({
        substrate_name: 'substrate-test',
        abduco_bin_path: '/tmp/abduco',
        state: 'live',
      }),
      sessionEnsureLive: async () => ({ state: 'live', substrate_name: 'substrate-test' }),
      sessionSendKeys: async () => ({}),
    } as unknown as VibecodiumClient;
    const child = new FakeChild();
    const pending = attachSession(client, SESSION_ID, spawnChild(child));
    await flushTasks();
    t.mock.timers.tick(60_000);
    child.exitCode = 0;
    child.emit('close', 0, null);
    await pending;
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = originalExitCode;
    t.mock.timers.reset();
  }
});
