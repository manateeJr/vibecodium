import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AbducoSubstrateClient, createSubstrateClient } from '../src/substrate/index.js';
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
