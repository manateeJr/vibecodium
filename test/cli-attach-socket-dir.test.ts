import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';
import test from 'node:test';
import type { VibecodiumClient } from '../src/client/index.js';
import { attachSession, type AttachSpawner } from '../src/cli-attach.js';

type SpawnCall = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Parameters<AttachSpawner>[2];
};

function fakeClient(socketDir?: string): VibecodiumClient {
  return {
    sessionAttachInfo: async () => ({
      substrate_name: 'substrate-test',
      abduco_bin_path: '/tmp/abduco',
      state: 'live',
      ...(socketDir === undefined ? {} : { socket_dir: socketDir }),
    }),
    sessionEnsureLive: async () => ({ state: 'live', substrate_name: 'substrate-test' }),
  } as unknown as VibecodiumClient;
}

function spawnSpy(calls: SpawnCall[]): AttachSpawner {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return {
      pid: 123,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    } as SpawnSyncReturns<Buffer>;
  };
}

test('attach passes the resolved socket directory to abduco', async () => {
  const calls: SpawnCall[] = [];
  const originalExitCode = process.exitCode;
  try {
    await attachSession(fakeClient('/run/user/1000/vc-test'), 'session-test', spawnSpy(calls));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options.env?.ABDUCO_SOCKET_DIR, '/run/user/1000/vc-test');
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('attach leaves the spawn environment unset when no socket directory is returned', async () => {
  const calls: SpawnCall[] = [];
  const originalExitCode = process.exitCode;
  try {
    await attachSession(fakeClient(), 'session-test', spawnSpy(calls));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options.env, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});
