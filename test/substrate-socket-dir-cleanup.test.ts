import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ControlPlane } from '../src/server/control-plane.js';
import { SessionTable } from '../src/session/session-table.js';
import { AbducoSubstrateClient } from '../src/substrate/index.js';
import { abducoBinaryPath, planeSocketDir, socketPathCandidates } from '../src/substrate/paths.js';

test('stopping a control plane removes an empty derived socket directory', async () => {
  const runtimeBase = fs.mkdtempSync(path.join('/tmp', 'v-'));
  const dataPath = path.join(runtimeBase, 'control-plane.sqlite');
  const previousSocketDir = process.env.ABDUCO_SOCKET_DIR;
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  delete process.env.ABDUCO_SOCKET_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeBase;
  let plane: ControlPlane | undefined;
  try {
    const derivedSocketDir = planeSocketDir(dataPath);
    assert.ok(derivedSocketDir);
    plane = new ControlPlane({ dataPath, port: 0 });
    await plane.start();
    assert.equal(fs.existsSync(derivedSocketDir), true);
    await plane.stop();
    plane = undefined;
    assert.equal(fs.existsSync(derivedSocketDir), false);
  } finally {
    await plane?.stop().catch(() => undefined);
    if (previousSocketDir === undefined) delete process.env.ABDUCO_SOCKET_DIR;
    else process.env.ABDUCO_SOCKET_DIR = previousSocketDir;
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    fs.rmSync(runtimeBase, { recursive: true, force: true });
  }
});

test('stopping a control plane keeps a derived socket directory with a live socket', async (t) => {
  const binaryPath = abducoBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`live substrate test skipped: ${binaryPath} is absent; run npm run setup:substrate`);
    return;
  }

  const runtimeBase = fs.mkdtempSync(path.join('/tmp', 'v-'));
  const dataPath = path.join(runtimeBase, 'control-plane.sqlite');
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
    client = new AbducoSubstrateClient({
      binaryPath,
      socketDir: derivedSocketDir,
      operationTimeoutMs: 3000,
    });
    await client.createSession(sessionName, ['/bin/sh', '-c', 'sleep 5'], {
      env: previousRuntimeDir === undefined ? {} : { XDG_RUNTIME_DIR: previousRuntimeDir },
    });
    table = new SessionTable({ filename: dataPath });
    table.upsert({
      sessionId,
      provider: 'omp',
      harnessRef: 'substrate-test',
      substrateName: sessionName,
      transcriptPath: path.join(runtimeBase, 'transcript.jsonl'),
      storageDir: path.join(runtimeBase, 'storage'),
      state: 'live',
      updatedAt: new Date().toISOString(),
    });
    plane = new ControlPlane({ dataPath, port: 0 });
    await plane.start();
    const socketPath = socketPathCandidates(sessionName, { socketDir: derivedSocketDir })[0];
    assert.ok(socketPath);
    assert.equal(fs.existsSync(socketPath), true);
    await plane.stop();
    plane = undefined;
    assert.equal(fs.existsSync(derivedSocketDir), true);
  } finally {
    await client?.kill(sessionName).catch(() => undefined);
    client?.dispose();
    await plane?.stop().catch(() => undefined);
    table?.close();
    if (previousSocketDir === undefined) delete process.env.ABDUCO_SOCKET_DIR;
    else process.env.ABDUCO_SOCKET_DIR = previousSocketDir;
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    fs.rmSync(runtimeBase, { recursive: true, force: true });
  }
});
