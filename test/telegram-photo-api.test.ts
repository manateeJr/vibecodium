import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramApi } from '../src/telegram/api.js';
import type { TelegramConfig, TelegramUpdate } from '../src/telegram/types.js';

const config: TelegramConfig = {
  token: '123:token',
  allowedUserId: 7,
  chatId: -1001,
  controlPlaneUrl: 'http://127.0.0.1:3000',
  dbPath: '/tmp/telegram.sqlite',
  pollTimeoutSec: 20,
  progressThrottleMs: 500,
  turnTimeoutMs: 60_000,
};

type RawMessage = Record<string, unknown>;

function rawMessage(fields: RawMessage = {}): RawMessage {
  return {
    chat: { id: -1001 },
    message_id: 10,
    from: { id: 7 },
    is_topic_message: false,
    ...fields,
  };
}

async function messageFor(message: RawMessage): Promise<NonNullable<TelegramUpdate['message']>> {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message }] }), {
      status: 200,
    });
  const api = createTelegramApi(config, fetchImpl);
  const updates = await api.getUpdates(0, 0);
  const mapped = updates[0]?.message;
  assert.ok(mapped);
  return mapped;
}

test('picks the largest photo by file_size', async () => {
  const mapped = await messageFor(
    rawMessage({
      photo: [
        { file_id: 'small', file_size: 100, width: 90, height: 90 },
        { file_id: 'large', file_size: 9000, width: 1280, height: 960 },
        { file_id: 'mid', file_size: 500, width: 320, height: 320 },
      ],
    }),
  );
  assert.deepEqual(mapped.photo, {
    fileId: 'large',
    mimeType: 'image/jpeg',
    fileSize: 9000,
    width: 1280,
    height: 960,
  });
});

test('ties on file_size resolve to the last entry', async () => {
  const mapped = await messageFor(
    rawMessage({
      photo: [
        { file_id: 'first', file_size: 1000, width: 100, height: 100 },
        { file_id: 'second', file_size: 1000, width: 100, height: 100 },
      ],
    }),
  );
  assert.equal(mapped.photo?.fileId, 'second');
});

test('falls back to width*height when file_size is missing', async () => {
  const mapped = await messageFor(
    rawMessage({
      photo: [
        { file_id: 'tiny', width: 90, height: 90 },
        { file_id: 'big', width: 1280, height: 960 },
      ],
    }),
  );
  assert.equal(mapped.photo?.fileId, 'big');
  assert.equal(mapped.photo?.mimeType, 'image/jpeg');
  assert.equal(mapped.photo?.fileSize, undefined);
});

test('defaults photo mime type to image/jpeg', async () => {
  const mapped = await messageFor(
    rawMessage({ photo: [{ file_id: 'photo-1', file_size: 42, width: 10, height: 10 }] }),
  );
  assert.deepEqual(mapped.photo, {
    fileId: 'photo-1',
    mimeType: 'image/jpeg',
    fileSize: 42,
    width: 10,
    height: 10,
  });
});

test('maps captions and keeps text alongside photo', async () => {
  const mapped = await messageFor(
    rawMessage({
      text: 'go',
      caption: 'look',
      photo: [{ file_id: 'photo-1', file_size: 7, width: 4, height: 4 }],
    }),
  );
  assert.equal(mapped.text, 'go');
  assert.equal(mapped.caption, 'look');
  assert.equal(mapped.photo?.fileId, 'photo-1');
});

test('ignores documents and leaves photo undefined', async () => {
  const mapped = await messageFor(rawMessage({ document: { file_id: 'doc-1' } }));
  assert.equal(mapped.photo, undefined);
});

test('leaves photo undefined for missing or empty arrays', async () => {
  const missing = await messageFor(rawMessage({}));
  assert.equal(missing.photo, undefined);
  const empty = await messageFor(rawMessage({ photo: [] }));
  assert.equal(empty.photo, undefined);
});

test('getFile and downloadFile are reused untouched for photo files', async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requests.push(input.toString());
    if (input.toString().endsWith('/getFile')) {
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: 'photos/file_1.jpg' } }),
        {
          status: 200,
        },
      );
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  const api = createTelegramApi(config, fetchImpl);
  const file = await api.getFile('photo-1');
  assert.deepEqual(file, { filePath: 'photos/file_1.jpg' });
  const bytes = await api.downloadFile(file.filePath);
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
  assert.equal(requests.length, 2);
});
