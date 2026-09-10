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

async function messageFor(
  message: RawMessage,
): Promise<NonNullable<TelegramUpdate['message']>> {
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

test('maps voice attachments with an audio/ogg default', async () => {
  const mapped = await messageFor(
    rawMessage({ voice: { file_id: 'voice-1', file_size: 1234 } }),
  );
  assert.deepEqual(mapped.voice, { fileId: 'voice-1', mimeType: 'audio/ogg', fileSize: 1234 });
});

test('keeps an explicit voice mime type', async () => {
  const mapped = await messageFor(
    rawMessage({ voice: { file_id: 'voice-2', mime_type: 'audio/mpeg', file_size: 99 } }),
  );
  assert.deepEqual(mapped.voice, { fileId: 'voice-2', mimeType: 'audio/mpeg', fileSize: 99 });
});

test('maps audio attachments with an audio/mpeg default', async () => {
  const mapped = await messageFor(rawMessage({ audio: { file_id: 'audio-1' } }));
  assert.deepEqual(mapped.voice, { fileId: 'audio-1', mimeType: 'audio/mpeg' });
});

test('maps video notes without a mime default', async () => {
  const mapped = await messageFor(rawMessage({ video_note: { file_id: 'note-1' } }));
  assert.deepEqual(mapped.voice, { fileId: 'note-1' });
});

test('prefers voice over audio over video_note', async () => {
  const all = await messageFor(
    rawMessage({
      voice: { file_id: 'voice-1' },
      audio: { file_id: 'audio-1' },
      video_note: { file_id: 'note-1' },
    }),
  );
  assert.equal(all.voice?.fileId, 'voice-1');

  const fallback = await messageFor(
    rawMessage({ audio: { file_id: 'audio-1' }, video_note: { file_id: 'note-1' } }),
  );
  assert.deepEqual(fallback.voice, { fileId: 'audio-1', mimeType: 'audio/mpeg' });
});

test('maps captions and keeps text alongside voice', async () => {
  const mapped = await messageFor(
    rawMessage({ text: 'go', caption: 'listen', voice: { file_id: 'voice-1' } }),
  );
  assert.equal(mapped.text, 'go');
  assert.equal(mapped.caption, 'listen');
  assert.equal(mapped.voice?.fileId, 'voice-1');
});

test('ignores documents', async () => {
  const mapped = await messageFor(rawMessage({ document: { file_id: 'doc-1' } }));
  assert.equal(mapped.voice, undefined);
});

test('getFile posts file_id and returns the file path', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: input.toString(), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.ogg' } }), {
      status: 200,
    });
  };
  const api = createTelegramApi(config, fetchImpl);
  const file = await api.getFile('voice-1');
  assert.deepEqual(file, { filePath: 'voice/file_1.ogg' });
  assert.equal(requests[0]?.url, 'https://api.telegram.org/bot123:token/getFile');
  assert.deepEqual(JSON.parse(requests[0]?.init.body as string), { file_id: 'voice-1' });
});

test('getFile throws when the file path is missing', async () => {
  for (const result of [{}, { file_path: '' }, { file_path: 42 }]) {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    const api = createTelegramApi(config, fetchImpl);
    await assert.rejects(api.getFile('voice-1'), /Telegram file is not ready yet/);
  }
});

test('downloadFile rejects empty and traversal paths without fetching', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response('nope', { status: 200 });
  };
  const api = createTelegramApi(config, fetchImpl);
  for (const filePath of ['', '/etc/passwd', 'voice/../../evil.ogg', 'a/../b']) {
    await assert.rejects(api.downloadFile(filePath), /Invalid Telegram file path/);
  }
  assert.equal(calls, 0);
});

test('downloadFile throws on HTTP errors', async () => {
  const fetchImpl: typeof fetch = async () => new Response('missing', { status: 404 });
  const api = createTelegramApi(config, fetchImpl);
  await assert.rejects(api.downloadFile('voice/file_1.ogg'), /HTTP 404/);
});

test('downloadFile enforces the 15 MB cap', async () => {
  const overLimit = String(15 * 1024 * 1024 + 1);
  const early: typeof fetch = async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-length': overLimit },
    });
  await assert.rejects(
    createTelegramApi(config, early).downloadFile('voice/file_1.ogg'),
    /15 MB limit/,
  );

  const late: typeof fetch = async () =>
    new Response(new Uint8Array(15 * 1024 * 1024 + 1), { status: 200 });
  await assert.rejects(
    createTelegramApi(config, late).downloadFile('voice/file_1.ogg'),
    /15 MB limit/,
  );
});

test('downloadFile returns bytes from the file endpoint', async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requests.push(input.toString());
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  const api = createTelegramApi(config, fetchImpl);
  const bytes = await api.downloadFile('voice/file_1.ogg');
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  assert.deepEqual(requests, ['https://api.telegram.org/file/bot123:token/voice/file_1.ogg']);
});
