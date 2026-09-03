import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AbducoSubstrateClient, createSubstrateClient } from '../src/substrate/index.js';
import { ControlPlane } from '../src/server/control-plane.js';
import { SessionSubsystem } from '../src/session/index.js';
import { SessionTable } from '../src/session/session-table.js';
import { abducoBinaryPath, planeSocketDir, socketPathCandidates } from '../src/substrate/paths.js';

async function waitForLive(client: AbducoSubstrateClient, name: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await client.isLive(name)) return;
    await delay(20);
  }
  assert.fail(`timed out waiting for abduco session ${name} to become live`);
}

test('constructing a substrate client creates its derived socket directory', () => {
  const runtimeBase = fs.mkdtempSync(path.join('/tmp', 'v-'));
  try {
    const socketDir = planeSocketDir(path.join(runtimeBase, 'state.sqlite'), {
      XDG_RUNTIME_DIR: runtimeBase,
    });
    assert.ok(socketDir);
    assert.equal(path.dirname(socketDir), runtimeBase);
    assert.match(path.basename(socketDir), /^vc-[0-9a-f]{8}$/);
    assert.equal(fs.existsSync(socketDir), false);

    createSubstrateClient({ socketDir });

    assert.equal(fs.existsSync(socketDir), true);
    assert.equal(fs.statSync(socketDir).mode & 0o777, 0o700);
    assert.ok(socketPathCandidates('substrate-x', { socketDir })[0]?.startsWith(socketDir));
  } finally {
    fs.rmSync(runtimeBase, { recursive: true, force: true });
  }
});

test('abduco creates its live socket under the derived socket directory', async (t) => {
  const binaryPath = abducoBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`live substrate test skipped: ${binaryPath} is absent; run npm run setup:substrate`);
    return;
  }

  const runtimeBase = fs.mkdtempSync(path.join('/tmp', 'v-'));
  const socketDir = planeSocketDir(path.join(runtimeBase, 'state.sqlite'), {
    XDG_RUNTIME_DIR: runtimeBase,
  });
  assert.ok(socketDir);
  assert.equal(fs.existsSync(socketDir), false);
  const sessionName = `substrate-${randomUUID()}`;
  let client: AbducoSubstrateClient | undefined;
  try {
    client = new AbducoSubstrateClient({ binaryPath, socketDir, operationTimeoutMs: 3000 });
    await client.createSession(sessionName, ['/bin/sh', '-c', 'sleep 5']);
    await waitForLive(client, sessionName);
    const socketPath = socketPathCandidates(sessionName, { socketDir })[0];
    assert.ok(socketPath);
    assert.equal(fs.existsSync(socketPath), true);
  } finally {
    await client?.kill(sessionName).catch(() => undefined);
    fs.rmSync(runtimeBase, { recursive: true, force: true });
  }
});

test('session.attach_info reports the socket directory containing a live substrate socket', async (t) => {
  const binaryPath = abducoBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`live substrate test skipped: ${binaryPath} is absent; run npm run setup:substrate`);
    return;
  }

  const runtimeBase = fs.mkdtempSync(path.join('/tmp', 'v-'));
  const dataPath = path.join(runtimeBase, 'control-plane.sqlite');
  const sessionTablePath = path.join(runtimeBase, 'sessions.sqlite');
  const previousSocketDir = process.env.ABDUCO_SOCKET_DIR;
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  delete process.env.ABDUCO_SOCKET_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeBase;
  const sessionId = randomUUID();
  const sessionName = `substrate-${sessionId}`;
  let client: AbducoSubstrateClient | undefined;
  let table: SessionTable | undefined;
  let plane: ControlPlane | undefined;
  try {
    const derivedSocketDir = planeSocketDir(dataPath);
    assert.ok(derivedSocketDir);
    client = new AbducoSubstrateClient({ binaryPath, operationTimeoutMs: 3000 });
    await client.createSession(sessionName, ['/bin/sh', '-c', 'sleep 5']);
    const now = new Date().toISOString();
    table = new SessionTable({ filename: sessionTablePath });
    table.upsert({
      sessionId,
      provider: 'omp',
      harnessRef: 'substrate-test',
      substrateName: sessionName,
      transcriptPath: path.join(runtimeBase, 'transcript.jsonl'),
      storageDir: path.join(runtimeBase, 'storage'),
      state: 'live',
      updatedAt: now,
    });
    const sessions = new SessionSubsystem({
      substrate: client,
      sessionTable: table,
      sessionStorageRoot: path.join(runtimeBase, 'session-storage'),
    });
    plane = new ControlPlane({ dataPath, port: 0, subsystems: [sessions] });
    const address = await plane.start();
    const response = await fetch(`${address.httpUrl}/commands/session.attach_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()).value as {
      readonly substrate_name: string;
      readonly socket_dir?: string;
    };
    assert.equal(result.substrate_name, sessionName);
    assert.equal(typeof result.socket_dir, 'string');
    assert.ok(result.socket_dir);
    const socketPath = socketPathCandidates(result.substrate_name, {
      socketDir: result.socket_dir,
    })[0];
    assert.ok(socketPath);
    assert.equal(fs.existsSync(socketPath), true);
    assert.equal(result.socket_dir, derivedSocketDir);
  } finally {
    await client?.kill(sessionName).catch(() => undefined);
    await plane?.stop().catch(() => undefined);
    table?.close();
    if (previousSocketDir === undefined) delete process.env.ABDUCO_SOCKET_DIR;
    else process.env.ABDUCO_SOCKET_DIR = previousSocketDir;
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    fs.rmSync(runtimeBase, { recursive: true, force: true });
  }
});
