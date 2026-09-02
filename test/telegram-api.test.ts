import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramApi } from '../src/telegram/api.js';
import type { TelegramConfig } from '../src/telegram/types.js';

type Script = { body: unknown; status?: number };
type RecordedRequest = { url: string; init: RequestInit };

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

function scriptedFetch(scripts: Script[], requests: RecordedRequest[]): typeof fetch {
  const fetchImpl: typeof fetch = async (input, init) => {
    const script = scripts.shift();
    if (script === undefined) throw new Error('unexpected Telegram request');
    requests.push({ url: input.toString(), init: init ?? {} });
    return new Response(JSON.stringify(script.body), { status: script.status ?? 200 });
  };
  return fetchImpl;
}

function jsonBody(request: RecordedRequest): Record<string, unknown> {
  assert.equal(typeof request.init.body, 'string');
  return JSON.parse(request.init.body as string) as Record<string, unknown>;
}

test('getUpdates posts and maps messages and callback queries', async () => {
  const requests: RecordedRequest[] = [];
  const scripts: Script[] = [
    {
      body: {
        ok: true,
        result: [
          {
            update_id: 41,
            message: {
              chat: { id: -1001 },
              message_thread_id: 9,
              message_id: 10,
              from: { id: 7, username: 'stefan' },
              text: 'hello',
              is_topic_message: true,
            },
          },
          {
            update_id: 42,
            callback_query: {
              id: 'callback-1',
              from: { id: 7 },
              data: 'session:stop',
              message: {
                chat: { id: -1001 },
                message_thread_id: 9,
                message_id: 11,
              },
            },
          },
        ],
      },
    },
  ];
  const api = createTelegramApi(config, scriptedFetch(scripts, requests));
  const controller = new AbortController();
  const updates = await api.getUpdates(40, 15, controller.signal);

  assert.equal(requests[0]?.url, 'https://api.telegram.org/bot123:token/getUpdates');
  assert.deepEqual(jsonBody(requests[0] as RecordedRequest), {
    offset: 40,
    timeout: 15,
    allowed_updates: ['message', 'callback_query'],
  });
  assert.equal(requests[0]?.init.signal, controller.signal);
  assert.deepEqual(updates, [
    {
      updateId: 41,
      message: {
        chatId: -1001,
        threadId: 9,
        messageId: 10,
        from: { id: 7, username: 'stefan' },
        text: 'hello',
        isTopicMessage: true,
      },
    },
    {
      updateId: 42,
      callbackQuery: {
        id: 'callback-1',
        from: { id: 7 },
        data: 'session:stop',
        message: { chatId: -1001, messageId: 11, threadId: 9 },
      },
    },
  ]);
});

test('sendMessage includes optional topic and inline keyboard fields', async () => {
  const requests: RecordedRequest[] = [];
  const scripts: Script[] = [
    { body: { ok: true, result: { message_id: 12 } } },
    { body: { ok: true, result: { message_id: 13 } } },
  ];
  const api = createTelegramApi(config, scriptedFetch(scripts, requests));

  assert.deepEqual(
    await api.sendMessage({
      chatId: -1001,
      threadId: 9,
      text: 'hello',
      markdown: true,
      buttons: [[{ text: 'Stop', callbackData: 'stop' }]],
    }),
    { messageId: 12 },
  );
  assert.deepEqual(await api.sendMessage({ chatId: -1001, text: 'no topic' }), { messageId: 13 });

  assert.equal(requests[0]?.url, 'https://api.telegram.org/bot123:token/sendMessage');
  assert.deepEqual(jsonBody(requests[0] as RecordedRequest), {
    chat_id: -1001,
    message_thread_id: 9,
    text: 'hello',
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: [[{ text: 'Stop', callback_data: 'stop' }]] },
  });
  const withoutThread = jsonBody(requests[1] as RecordedRequest);
  assert.equal('message_thread_id' in withoutThread, false);
});

test('editMessageText posts its message and markdown fields', async () => {
  const requests: RecordedRequest[] = [];
  const api = createTelegramApi(
    config,
    scriptedFetch([{ body: { ok: true, result: true } }], requests),
  );

  await api.editMessageText({ chatId: -1001, messageId: 20, text: '*done*', markdown: true });
  assert.deepEqual(jsonBody(requests[0] as RecordedRequest), {
    chat_id: -1001,
    message_id: 20,
    text: '*done*',
    parse_mode: 'MarkdownV2',
  });
});

test('sendDocument posts multipart form data with a markdown document', async () => {
  const requests: RecordedRequest[] = [];
  const api = createTelegramApi(
    config,
    scriptedFetch([{ body: { ok: true, result: { message_id: 21 } } }], requests),
  );

  assert.deepEqual(
    await api.sendDocument({
      chatId: -1001,
      threadId: 9,
      filename: 'report.md',
      content: '# Report',
      caption: 'latest',
    }),
    { messageId: 21 },
  );

  const body = requests[0]?.init.body;
  assert.equal(body instanceof FormData, true);
  const form = body as FormData;
  assert.equal(form.get('chat_id'), '-1001');
  assert.equal(form.get('message_thread_id'), '9');
  assert.equal(form.get('caption'), 'latest');
  const document = form.get('document');
  assert.equal(document instanceof Blob, true);
  assert.equal((document as Blob).type, 'text/markdown');
  assert.equal(await (document as Blob).text(), '# Report');
  assert.equal(new Headers(requests[0]?.init.headers).has('content-type'), false);
});

test('remaining API methods map their results', async () => {
  const requests: RecordedRequest[] = [];
  const api = createTelegramApi(
    config,
    scriptedFetch(
      [
        { body: { ok: true, result: { id: 99, username: 'bot' } } },
        { body: { ok: true, result: { message_thread_id: 33 } } },
        { body: { ok: true, result: true } },
      ],
      requests,
    ),
    'http://127.0.0.1:39876/telegram/',
  );

  assert.deepEqual(await api.getMe(), { id: 99, username: 'bot' });
  assert.deepEqual(await api.createForumTopic({ chatId: -1001, name: 'Session' }), {
    threadId: 33,
  });
  await api.answerCallbackQuery('callback-1', 'Stopped');
  assert.equal(requests[0]?.url, 'http://127.0.0.1:39876/telegram/bot123:token/getMe');
  assert.deepEqual(jsonBody(requests[1] as RecordedRequest), { chat_id: -1001, name: 'Session' });
  assert.deepEqual(jsonBody(requests[2] as RecordedRequest), {
    callback_query_id: 'callback-1',
    text: 'Stopped',
  });
});

test('429 retry_after retries once and then succeeds', async () => {
  const requests: RecordedRequest[] = [];
  const api = createTelegramApi(
    config,
    scriptedFetch(
      [
        {
          status: 429,
          body: {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 0 },
          },
        },
        { body: { ok: true, result: { message_id: 22 } } },
      ],
      requests,
    ),
  );

  assert.deepEqual(await api.sendMessage({ chatId: -1001, text: 'retry' }), { messageId: 22 });
  assert.equal(requests.length, 2);
});

test('Telegram ok:false errors include code and description', async () => {
  const api = createTelegramApi(
    config,
    scriptedFetch(
      [{ body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } }],
      [],
    ),
  );

  await assert.rejects(
    api.sendMessage({ chatId: -1001, text: 'fail' }),
    /Telegram API error 400: Bad Request: chat not found/,
  );
});
