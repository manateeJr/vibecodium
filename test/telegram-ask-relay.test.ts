import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAskKeyboard,
  buildAskText,
  createAskRelay,
  formatAskCallback,
  normalizeAskRequest,
  parseAskCallback,
  type AskAnswer,
  type AskAnswerOutcome,
  type AskRelay,
  type AskRequestedWire,
} from '../src/telegram/ask-relay.js';
import { createTelegramBot, type TelegramFormat } from '../src/telegram/bot.js';
import { escapeMarkdownV2 } from '../src/telegram/format.js';
import type {
  CallbackQuery,
  SessionBridge,
  TelegramApi,
  TelegramConfig,
  TelegramUpdate,
  TopicBinding,
  TopicStore,
} from '../src/telegram/types.js';

type SendMessageParams = Parameters<TelegramApi['sendMessage']>[0];
type EditMessageParams = Parameters<TelegramApi['editMessageText']>[0];
type SentMessage = SendMessageParams & { messageId: number };

const CHAT_ID = -1001;
const THREAD_ID = 700;
const USER_ID = 42;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

function wireRequest(overrides: Partial<AskRequestedWire> = {}): AskRequestedWire {
  return {
    session_id: 's-1',
    turn: 6,
    ask_id: 'ask-1',
    questions: [
      {
        id: 'q-1',
        header: 'File under which map?',
        question: 'Pick a target for this finding.',
        options: [{ label: 'File it' }, { label: "Don't file", description: 'skip it' }],
      },
    ],
    source: 'omp-ask',
    requested_at: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

class FakeApi implements TelegramApi {
  readonly sentMessages: SentMessage[] = [];
  readonly editedMessages: EditMessageParams[] = [];
  readonly markupEdits: Array<{ chatId: number; messageId: number; buttons?: unknown }> = [];
  readonly callbackAcks: Array<{ id: string; text?: string }> = [];
  private nextMessageId = 100;

  async getMe(): Promise<{ id: number; username: string }> {
    return { id: 1, username: 'test-bot' };
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }

  async sendMessage(params: SendMessageParams): Promise<{ messageId: number }> {
    this.nextMessageId += 1;
    const messageId = this.nextMessageId;
    this.sentMessages.push({ ...params, messageId });
    return { messageId };
  }

  async editMessageText(params: EditMessageParams): Promise<void> {
    this.editedMessages.push(params);
  }

  async editMessageReplyMarkup(params: {
    chatId: number;
    messageId: number;
    buttons?: { text: string; callbackData: string }[][];
  }): Promise<void> {
    this.markupEdits.push(params);
  }

  async sendDocument(): Promise<{ messageId: number }> {
    this.nextMessageId += 1;
    return { messageId: this.nextMessageId };
  }

  async createForumTopic(): Promise<{ threadId: number }> {
    return { threadId: THREAD_ID };
  }

  async editForumTopic(): Promise<void> {}

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    if (text === undefined) this.callbackAcks.push({ id });
    else this.callbackAcks.push({ id, text });
  }
}

class FakeAskBridge {
  onAsk: ((request: AskRequestedWire) => void) | undefined;
  readonly answerCalls: AskAnswer[] = [];
  answerOutcome: AskAnswerOutcome | void = undefined;
  answerError: unknown;
  openTurnValue: number | null = 6;
  readonly unsubscribed: boolean[] = [];

  subscribeAsk = (onAsk: (request: AskRequestedWire) => void): (() => void) => {
    this.onAsk = onAsk;
    return () => {
      this.unsubscribed.push(true);
    };
  };

  subscribeSession = (): (() => void) => () => undefined;

  openTurn = async (): Promise<number | null> => this.openTurnValue;

  answerAsk = async (answer: AskAnswer): Promise<AskAnswerOutcome | void> => {
    this.answerCalls.push(answer);
    if (this.answerError !== undefined) throw this.answerError;
    return this.answerOutcome;
  };
}

class StubStore implements TopicStore {
  private readonly bySessionId = new Map<string, TopicBinding>();
  private readonly byThreadId = new Map<number, TopicBinding>();

  bind(binding: TopicBinding): void {
    this.bySessionId.set(binding.sessionId, binding);
    this.byThreadId.set(binding.threadId, binding);
  }

  byThread(threadId: number): TopicBinding | null {
    return this.byThreadId.get(threadId) ?? null;
  }

  bySession(sessionId: string): TopicBinding | null {
    return this.bySessionId.get(sessionId) ?? null;
  }

  all(): TopicBinding[] {
    return [...this.bySessionId.values()];
  }

  unbind(threadId: number): void {
    const binding = this.byThreadId.get(threadId);
    if (binding !== undefined) {
      this.byThreadId.delete(threadId);
      this.bySessionId.delete(binding.sessionId);
    }
  }

  rename(): void {}

  getOffset(): number {
    return 0;
  }

  setOffset(): void {}

  close(): void {}
}

const format: TelegramFormat = {
  escapeMarkdownV2,
  chunkText: (text) => [text],
};

function binding(): TopicBinding {
  return {
    threadId: THREAD_ID,
    sessionId: 's-1',
    label: 'demo · hello',
    createdAt: new Date(0).toISOString(),
  };
}

function fixture(options: { timeoutMs?: number } = {}): {
  api: FakeApi;
  bridge: FakeAskBridge;
  store: StubStore;
  relay: AskRelay;
} {
  const api = new FakeApi();
  const bridge = new FakeAskBridge();
  const store = new StubStore();
  store.bind(binding());
  const relay = createAskRelay({
    api,
    bridge: bridge as unknown as SessionBridge & Parameters<typeof createAskRelay>[0]['bridge'],
    store,
    chatId: CHAT_ID,
    format,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { api, bridge, store, relay };
}

function callback(data: string, messageId: number): CallbackQuery {
  return {
    id: `cb-${messageId}-${data.length}`,
    from: { id: USER_ID },
    data,
    message: { chatId: CHAT_ID, messageId, threadId: THREAD_ID },
  };
}

test('ask callback data round-trips through format and parse', () => {
  const data = formatAskCallback('ask-1', 0, 1);
  assert.deepStrictEqual(parseAskCallback(data), {
    askId: 'ask-1',
    questionIndex: 0,
    optionIndex: 1,
  });
  assert.equal(parseAskCallback('resume:1:2'), null);
  assert.equal(parseAskCallback('ask:broken'), null);
  assert.equal(parseAskCallback('ask:%ZZ:0:0'), null);
});

test('ask text and keyboard render every question with per-option buttons', () => {
  const request = normalizeAskRequest(wireRequest());
  const text = buildAskText(request, escapeMarkdownV2);
  assert.match(text, /File under which map\?/);
  assert.match(text, /Don't file/);
  const keyboard = buildAskKeyboard(request);
  assert.equal(keyboard.length, 2);
  assert.equal(keyboard[1]?.[0]?.callbackData, formatAskCallback('ask-1', 0, 1));
});

test('subscribeAsk renders the ask once into the bound topic', async () => {
  const { api, bridge, relay } = fixture();
  relay.start();
  assert.ok(bridge.onAsk);
  bridge.onAsk(wireRequest());
  bridge.onAsk(wireRequest());
  await flush();
  assert.equal(api.sentMessages.length, 1);
  assert.equal(api.sentMessages[0]?.threadId, THREAD_ID);
  assert.equal(api.sentMessages[0]?.buttons?.length, 2);
});

test('asks for unbound sessions and stale turns are skipped', async () => {
  const live = fixture();
  live.relay.start();
  assert.ok(live.bridge.onAsk);
  live.bridge.onAsk(wireRequest({ session_id: 'unknown' }));
  await flush();
  assert.equal(live.api.sentMessages.length, 0);

  const stale = fixture();
  stale.bridge.openTurnValue = null;
  stale.relay.start();
  assert.ok(stale.bridge.onAsk);
  stale.bridge.onAsk(wireRequest());
  await flush();
  assert.equal(stale.api.sentMessages.length, 0);
});

test('callback answers via answerAsk with the contract payload and edits once', async () => {
  const { api, bridge, relay } = fixture();
  await relay.renderAsk(normalizeAskRequest(wireRequest()));
  const messageId = api.sentMessages[0]?.messageId;
  assert.ok(messageId);

  const handled = await relay.handleCallback(callback(formatAskCallback('ask-1', 0, 1), messageId));
  assert.equal(handled, true);
  assert.deepStrictEqual(bridge.answerCalls, [
    { session_id: 's-1', ask_id: 'ask-1', question_id: 'q-1', option_index: 1 },
  ]);
  assert.equal(api.editedMessages.length, 1);
  assert.match(api.editedMessages[0]?.text ?? '', /Don't file/);
  assert.equal(api.markupEdits.length, 1);
  assert.deepStrictEqual(api.markupEdits[0]?.buttons, []);
  assert.equal(api.callbackAcks.length, 1);

  const repeated = await relay.handleCallback(
    callback(formatAskCallback('ask-1', 0, 1), messageId),
  );
  assert.equal(repeated, true);
  assert.equal(bridge.answerCalls.length, 1);
  assert.equal(api.editedMessages.length, 1);
  assert.equal(api.callbackAcks.length, 2);
});

test('a denied outcome renders the declined state', async () => {
  const { api, bridge, relay } = fixture();
  bridge.answerOutcome = { status: 'denied' };
  await relay.renderAsk(normalizeAskRequest(wireRequest()));
  const messageId = api.sentMessages[0]?.messageId;
  assert.ok(messageId);
  await relay.handleCallback(callback(formatAskCallback('ask-1', 0, 0), messageId));
  assert.equal(api.editedMessages.length, 1);
  assert.match(api.editedMessages[0]?.text ?? '', /🚫 declined/);
});

test('a failed submit keeps the question open for retry', async () => {
  const { api, bridge, relay } = fixture();
  bridge.answerError = new Error('control plane down');
  await relay.renderAsk(normalizeAskRequest(wireRequest()));
  const messageId = api.sentMessages[0]?.messageId;
  assert.ok(messageId);
  await relay.handleCallback(callback(formatAskCallback('ask-1', 0, 0), messageId));
  assert.equal(api.editedMessages.length, 0);

  bridge.answerError = undefined;
  await relay.handleCallback(callback(formatAskCallback('ask-1', 0, 0), messageId));
  assert.equal(bridge.answerCalls.length, 2);
  assert.equal(api.editedMessages.length, 1);
});

test('unknown asks and foreign callbacks never reach answerAsk', async () => {
  const { api, bridge, relay } = fixture();
  await relay.renderAsk(normalizeAskRequest(wireRequest()));
  assert.equal(await relay.handleCallback(callback('ask:missing:0:0', 999)), true);
  assert.equal(await relay.handleCallback(callback('resume:1:2', 999)), false);
  assert.equal(bridge.answerCalls.length, 0);
  assert.equal(api.editedMessages.length, 0);
  assert.equal(api.callbackAcks.length, 1);
});

test('an unanswered ask expires and locks against late answers', async () => {
  const { api, bridge, relay } = fixture({ timeoutMs: 15 });
  await relay.renderAsk(normalizeAskRequest(wireRequest()));
  const messageId = api.sentMessages[0]?.messageId;
  assert.ok(messageId);
  await sleep(60);
  assert.equal(api.editedMessages.length, 1);
  assert.match(api.editedMessages[0]?.text ?? '', /expired/);

  await relay.handleCallback(callback(formatAskCallback('ask-1', 0, 0), messageId));
  assert.equal(bridge.answerCalls.length, 0);
  assert.equal(api.editedMessages.length, 1);
});

test('markDenied renders the declined state exactly once', async () => {
  const { api, relay } = fixture();
  await relay.renderAsk(normalizeAskRequest(wireRequest()));
  await relay.markDenied('ask-1');
  await relay.markDenied('ask-1');
  await relay.markTimedOut('ask-1');
  assert.equal(api.editedMessages.length, 1);
  assert.match(api.editedMessages[0]?.text ?? '', /🚫 declined/);
});

test('bot routes subscribeAsk into the topic and callbacks into answerAsk', async () => {
  const api = new FakeApi();
  const bridge = new FakeAskBridge();
  const store = new StubStore();
  store.bind(binding());
  const config: TelegramConfig = {
    token: 'token',
    allowedUserId: USER_ID,
    chatId: CHAT_ID,
    controlPlaneUrl: 'http://127.0.0.1:4310',
    dbPath: ':memory:',
    pollTimeoutSec: 50,
    progressThrottleMs: 5_000,
    turnTimeoutMs: 30 * 60 * 1_000,
  };
  const bot = createTelegramBot({
    api,
    bridge: bridge as unknown as SessionBridge,
    store,
    config,
    format,
  });
  bot.start();
  assert.ok(bridge.onAsk);
  bridge.onAsk(wireRequest());
  await flush();
  assert.equal(api.sentMessages.length, 1);
  const messageId = api.sentMessages[0]?.messageId;
  assert.ok(messageId);

  const update: TelegramUpdate = {
    updateId: 1,
    callbackQuery: callback(formatAskCallback('ask-1', 0, 1), messageId),
  };
  await bot.handleUpdate(update);
  assert.deepStrictEqual(bridge.answerCalls, [
    { session_id: 's-1', ask_id: 'ask-1', question_id: 'q-1', option_index: 1 },
  ]);
  assert.equal(api.editedMessages.length, 1);
});
