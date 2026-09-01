import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AbducoSubstrateClient } from '../src/substrate/index.js';
import { abducoBinaryPath } from '../src/substrate/paths.js';

async function waitForLive(client: AbducoSubstrateClient, name: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await client.isLive(name)) return;
    await delay(20);
  }
  assert.fail(`timed out waiting for abduco session ${name} to become live`);
}

test('abduco socket namespaces isolate sessions from sibling planes', async (t) => {
  const binaryPath = abducoBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`live substrate test skipped: ${binaryPath} is absent; run npm run setup:substrate`);
    return;
  }

  let socketDirA: string | undefined;
  let socketDirB: string | undefined;
  let clientA: AbducoSubstrateClient | undefined;
  const sessionName = `substrate-${randomUUID()}`;
  try {
    const socketBase = process.env.XDG_RUNTIME_DIR?.length ? process.env.XDG_RUNTIME_DIR : '/tmp';
    const dirA = fs.mkdtempSync(path.join(socketBase, 'v'));
    const dirB = fs.mkdtempSync(path.join(socketBase, 'v'));

    socketDirA = dirA;
    socketDirB = dirB;
    clientA = new AbducoSubstrateClient({
      binaryPath,
      socketDir: dirA,
      operationTimeoutMs: 3000,
    });
    const clientB = new AbducoSubstrateClient({
      binaryPath,
      socketDir: dirB,
      operationTimeoutMs: 3000,
    });

    await clientA.createSession(sessionName, ['/bin/sh', '-c', 'sleep 30']);
    await waitForLive(clientA, sessionName);
    assert.ok((await clientA.listSessions()).some((session) => session.name === sessionName));
    assert.ok(!(await clientB.listSessions()).some((session) => session.name === sessionName));
  } finally {
    await clientA?.kill(sessionName).catch(() => undefined);
    if (socketDirA !== undefined) fs.rmSync(socketDirA, { recursive: true, force: true });
    if (socketDirB !== undefined) fs.rmSync(socketDirB, { recursive: true, force: true });
  }
});
