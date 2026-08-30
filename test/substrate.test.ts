import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { endianness } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  AbducoSubstrateClient,
  FrameDecoder,
  encodeFrame,
  MAX_PAYLOAD_BYTES,
  MESSAGE_TYPES,
  parseSessionListing,
} from '../src/substrate/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const binaryPath = path.join(repositoryRoot, '.vibecodium', 'bin', 'abduco');

function expectedNativeBytes(value: number, width: 2 | 4): Buffer {
  const bytes = Buffer.alloc(width);
  if (width === 2) {
    if (endianness() === 'LE') bytes.writeUInt16LE(value);
    else bytes.writeUInt16BE(value);
  } else if (endianness() === 'LE') bytes.writeUInt32LE(value);
  else bytes.writeUInt32BE(value);
  return bytes;
}

async function waitForOutput(chunks: readonly Buffer[], text: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (Buffer.concat(chunks).includes(text)) return;
    await delay(20);
  }
  assert.fail(
    `timed out waiting for PTY output ${JSON.stringify(text)}; got ${Buffer.concat(chunks).toString()}`,
  );
}

test('abduco framing round-trips with native-endian fields', () => {
  const payload = Uint8Array.from([0, 13, 27, 255]);
  const frame = encodeFrame(0x01020304, payload);
  assert.deepEqual(frame.subarray(0, 4), expectedNativeBytes(0x01020304, 4));
  assert.deepEqual(frame.subarray(4, 8), expectedNativeBytes(payload.length, 4));
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame), [{ type: 0x01020304, payload }]);
  assert.equal(decoder.pendingBytes, 0);
});

test('abduco decoder reassembles split frames and the 4088-byte boundary', () => {
  const payload = Uint8Array.from({ length: MAX_PAYLOAD_BYTES }, (_, index) => index % 251);
  const frame = encodeFrame(MESSAGE_TYPES.content, payload);
  const decoder = new FrameDecoder();
  const frames = [
    ...decoder.push(frame.subarray(0, 1)),
    ...decoder.push(frame.subarray(1, 7)),
    ...decoder.push(frame.subarray(7, 8)),
    ...decoder.push(frame.subarray(8, 2049)),
    ...decoder.push(frame.subarray(2049)),
  ];
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { type: MESSAGE_TYPES.content, payload });
  assert.throws(
    () => encodeFrame(MESSAGE_TYPES.content, new Uint8Array(MAX_PAYLOAD_BYTES + 1)),
    /4088/,
  );
});

test('abduco listing parser preserves session names and liveness marker', () => {
  const listing = [
    'Active sessions (on host test-host)',
    '  Sun\t 2026-08-30 10:08:32\t123\tquiet',
    '* Sun\t 2026-08-30 10:08:33\t124\tattached',
    '+ Sun\t 2026-08-30 10:08:34\t125\tdead',
    '',
  ].join('\n');
  assert.deepEqual(parseSessionListing(listing), [
    { name: 'quiet', live: true },
    { name: 'attached', live: true },
    { name: 'dead', live: false },
  ]);
});

test('live cat attachment survives a forced socket disconnect and reattaches', async (t) => {
  if (!fs.existsSync(binaryPath)) {
    t.skip(`live substrate test skipped: ${binaryPath} is absent; run npm run setup:substrate`);
    return;
  }
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'vibecodium-substrate-'));
  const sessionName = `cat-${process.pid}-${Date.now()}`;
  const client = new AbducoSubstrateClient({
    binaryPath,
    socketDir,
    reattachMinDelayMs: 10,
    reattachMaxDelayMs: 100,
    operationTimeoutMs: 3000,
  });
  const chunks: Buffer[] = [];
  const unsubscribe = client.onOutput(({ data }) => chunks.push(Buffer.from(data)));
  t.after(async () => {
    unsubscribe();
    await client.kill(sessionName).catch(() => undefined);
    await attachment.detach().catch(() => undefined);
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  const created = await client.createSession(sessionName, ['cat']);
  assert.deepEqual(created, { name: sessionName, live: true });
  const attachment: { detach(): Promise<void> } = await client.attach(sessionName);
  await client.write(sessionName, Buffer.from('first-line\n'));
  await waitForOutput(chunks, 'first-line');

  const internals = client as unknown as {
    attachments: Map<string, { connection: { destroy(): void } | undefined }>;
  };
  const state = internals.attachments.get(sessionName);
  assert.ok(state);
  const firstConnection = state.connection;
  assert.ok(firstConnection);
  firstConnection.destroy();
  const reconnectDeadline = Date.now() + 1000;
  while (state.connection === firstConnection && Date.now() < reconnectDeadline) await delay(10);
  assert.notEqual(state.connection, firstConnection);

  await client.write(sessionName, Buffer.from('second-line\n'));
  await waitForOutput(chunks, 'second-line');
  assert.equal(await client.isLive(sessionName), true);
});
