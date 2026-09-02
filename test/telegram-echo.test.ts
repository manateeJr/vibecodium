import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramBot, type TelegramBot } from '../src/telegram/bot.js';
import { createEcho } from '../src/telegram/echo.js';
import { escapeMarkdownV2, chunkText } from '../src/telegram/format.js';
import { createSessionWatch, type SessionWatch } from '../src/telegram/session-watch.js';
import type {
  MachineSessionLite,
  ObservedTurn,
  SessionBridge,
  SessionLite,
  TelegramApi,
  TelegramConfig,
  TelegramUpdate,
  TopicBinding,
  TopicStore,
  TurnResult,
} from '../src/telegram/types.js';

type SendMessageParams = Parameters<TelegramApi['sendMessage']>[0];
type EditMessageParams = Parameters<TelegramApi['editMessageText']>[0];
type DocumentParams = Parameters<TelegramApi['sendDocument']>[0];
type SubscribeParams = Parameters<SessionBridge['subscribeSession']>[0];

type SentMessage = SendMessageParams & { messageId: number };

class FakeApi implements TelegramApi {
  readonly sentMessages: SentMessage[] = [];
  readonly editedMessages: EditMessageParams[] = [];
  readonly documents: DocumentParams[] = [];
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
  async editMessageReplyMarkup(): Promise<void> {}
  async sendDocument(params: DocumentParams): Promise<{ messageId: number }> {
    this.documents.push(params);
    this.nextMessageId += 1;
    return { messageId: this.nextMessageId };
  }
  async createForumTopic(): Promise<{ threadId: number }> {
    return { threadId: 1 };
  }
  async editForumTopic(): Promise<void> {}
  async answerCallbackQuery(): Promise<void> {}
}

class FakeBridge implements SessionBridge {
  readonly subscribeCalls: SubscribeParams[] = [];
  readonly unsubscribeCalls: string[] = [];
  readonly sendCalls: Array<{ sessionId: string; prompt: string }> = [];
  readonly stopCalls: string[] = [];
  readonly callbacks = new Map<string, SubscribeParams['onTurn']>();
  sessions: SessionLite[] = [];
  openTurnResult: number | null = null;

  async health(): Promise<boolean> {
    return true;
  }
  async projects(): Promise<Array<{ name: string; path: string }>> {
    return [];
  }
  async open(): Promise<{ sessionId: string; turn: number }> {
    return { sessionId: 'session-1', turn: 1 };
  }
  async machineSessions(): Promise<MachineSessionLite[]> {
    return [];
  }
  async resume(): Promise<{ sessionId: string; turn: number }> {
    return { sessionId: 'session-1', turn: 1 };
  }
  async send(params: { sessionId: string; prompt: string }): Promise<{ turn: number }> {
    this.sendCalls.push(params);
    return { turn: this.sendCalls.length };
  }
  async stop(sessionId: string): Promise<boolean> {
    this.stopCalls.push(sessionId);
    return true;
  }
  async rename(): Promise<void> {}
  async list(): Promise<SessionLite[]> {
    return this.sessions;
  }
  async watchTurn(): Promise<TurnResult> {
    return { status: 'complete', text: '', elapsedMs: 1, toolCalls: 0 };
  }
  subscribeSession(params: SubscribeParams): () => void {
    this.subscribeCalls.push(params);
    this.callbacks.set(params.sessionId, params.onTurn);
    return () => {
      this.unsubscribeCalls.push(params.sessionId);
    };
  }
  async openTurn(): Promise<number | null> {
    return this.openTurnResult;
  }

  emit(turn: ObservedTurn): void {
    this.callbacks.get(turn.sessionId)?.(turn);
  }
}

class FakeStore implements TopicStore {
  readonly bindings: TopicBinding[] = [];
  private offset = 0;

  bind(binding: TopicBinding): void {
    this.bindings.push(binding);
  }
  byThread(threadId: number): TopicBinding | null {
    return this.bindings.find((binding) => binding.threadId === threadId) ?? null;
  }
  bySession(sessionId: string): TopicBinding | null {
    return this.bindings.find((binding) => binding.sessionId === sessionId) ?? null;
  }
  all(): TopicBinding[] {
    return [...this.bindings];
  }
  unbind(threadId: number): void {
    const index = this.bindings.findIndex((binding) => binding.threadId === threadId);
    if (index >= 0) this.bindings.splice(index, 1);
  }
  rename(threadId: number, label: string): void {
    const binding = this.byThread(threadId);
    if (binding !== null) binding.label = label;
  }
  getOffset(): number {
    return this.offset;
  }
  setOffset(offset: number): void {
    this.offset = offset;
  }
  close(): void {}
}

function binding(sessionId: string, threadId: number): TopicBinding {
  return {
    threadId,
    sessionId,
    label: `topic-${sessionId}`,
    createdAt: new Date(0).toISOString(),
  };
}

function observed(sessionId: string, turn: number, prompt: string, text: string): ObservedTurn {
  return {
    sessionId,
    turn,
    prompt,
    text,
    completedAt: new Date(0).toISOString(),
  };
}

function createFixture(): {
  api: FakeApi;
  bridge: FakeBridge;
  store: FakeStore;
  watch: SessionWatch;
} {
  const api = new FakeApi();
  const bridge = new FakeBridge();
  const store = new FakeStore();
  const echo = createEcho({
    api,
    store,
    format: { escapeMarkdownV2, chunkText },
    chatId: -1001,
  });
  const watch = createSessionWatch({ bridge, store, echoTurn: echo.echoTurn });
  return { api, bridge, store, watch };
}

function config(): TelegramConfig {
  return {
    token: 'token',
    allowedUserId: 42,
    chatId: -1001,
    controlPlaneUrl: 'http://127.0.0.1:4310',
    dbPath: ':memory:',
    pollTimeoutSec: 50,
    progressThrottleMs: 5_000,
    turnTimeoutMs: 30 * 60 * 1_000,
  };
}

function topicUpdate(text: string, threadId: number): TelegramUpdate {
  return {
    updateId: threadId,
    message: {
      chatId: -1001,
      threadId,
      messageId: threadId,
      from: { id: 42 },
      text,
      isTopicMessage: true,
    },
  };
}

function createBotFixture(): {
  api: FakeApi;
  bridge: FakeBridge;
  store: FakeStore;
  bot: TelegramBot;
} {
  const api = new FakeApi();
  const bridge = new FakeBridge();
  const store = new FakeStore();
  const bot = createTelegramBot({
    api,
    bridge,
    store,
    config: config(),
    format: { escapeMarkdownV2, chunkText },
  });
  return { api, bridge, store, bot };
}

test('an observed PC turn is echoed into its bound topic without progress edits', async () => {
  const fixture = createFixture();
  fixture.store.bind(binding('session-1', 600));
  fixture.watch.watch('session-1');

  fixture.bridge.emit(observed('session-1', 7, 'PC asks *now*', 'assistant output'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    fixture.api.sentMessages.map(({ chatId, threadId, text, markdown }) => ({
      chatId,
      threadId,
      text,
      markdown,
    })),
    [
      { chatId: -1001, threadId: 600, text: '▶ PC asks \\*now\\*', markdown: true },
      { chatId: -1001, threadId: 600, text: 'assistant output', markdown: true },
    ],
  );
  assert.equal(fixture.api.editedMessages.length, 0);
  assert.equal(fixture.api.documents.length, 0);
});

test('a relayed turn is suppressed by both the turn and prompt ledgers', async () => {
  const fixture = createFixture();
  fixture.store.bind(binding('session-1', 601));
  fixture.watch.watch('session-1');

  fixture.watch.markSent('session-1', 'same prompt');
  fixture.bridge.emit(observed('session-1', 1, 'same prompt', 'already relayed'));
  fixture.watch.markRelayed('session-1', 2);
  fixture.bridge.emit(observed('session-1', 2, 'different prompt', 'already relayed'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fixture.api.sentMessages.length, 0);

  fixture.bridge.emit(observed('session-1', 3, 'same prompt', 'new PC output'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.api.sentMessages.length, 2);
});

test('start subscribes once for every existing binding and remains idempotent', () => {
  const fixture = createFixture();
  fixture.store.bind(binding('session-1', 602));
  fixture.store.bind(binding('session-2', 603));

  fixture.watch.start();
  fixture.watch.start();

  assert.deepEqual(
    fixture.bridge.subscribeCalls.map(({ sessionId, fromTail }) => ({ sessionId, fromTail })),
    [
      { sessionId: 'session-1', fromTail: true },
      { sessionId: 'session-2', fromTail: true },
    ],
  );
});

test('unwatch unsubscribes and ignores turns delivered by the old subscription', async () => {
  const fixture = createFixture();
  fixture.store.bind(binding('session-1', 604));
  fixture.watch.watch('session-1');
  fixture.bridge.emit(observed('session-1', 1, 'before stop', 'visible'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.api.sentMessages.length, 2);

  fixture.watch.unwatch('session-1');
  fixture.bridge.emit(observed('session-1', 2, 'after stop', 'hidden'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.bridge.unsubscribeCalls, ['session-1']);
  assert.equal(fixture.api.sentMessages.length, 2);
});

test('echo renders empty output and long output using relay chunk/document rules', async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  store.bind(binding('session-1', 605));
  const echo = createEcho({
    api,
    store,
    format: {
      escapeMarkdownV2: (text) => text,
      chunkText: (text) => (text === 'long' ? ['one', 'two', 'three', 'four'] : []),
    },
    chatId: -1001,
  });

  await echo.echoTurn(observed('session-1', 9, 'empty', ''));
  assert.equal(api.sentMessages.at(-1)?.text, '(no output)');

  await echo.echoTurn(observed('session-1', 10, 'long', 'long'));
  assert.deepEqual(api.documents, [
    { chatId: -1001, threadId: 605, filename: 'turn-10.md', content: 'long' },
  ]);
});

test('bot.start subscribes once for each binding already in the store', () => {
  const fixture = createBotFixture();
  fixture.store.bind(binding('session-1', 606));
  fixture.store.bind(binding('session-2', 607));

  fixture.bot.start();
  fixture.bot.start();

  assert.deepEqual(
    fixture.bridge.subscribeCalls.map(({ sessionId, fromTail }) => ({ sessionId, fromTail })),
    [
      { sessionId: 'session-1', fromTail: true },
      { sessionId: 'session-2', fromTail: true },
    ],
  );
});

test('a bot-relayed turn emitted after send is not echoed a second time', async () => {
  const fixture = createBotFixture();
  fixture.store.bind(binding('session-1', 608));
  fixture.bot.start();

  await fixture.bot.handleUpdate(topicUpdate('phone prompt', 608));
  const sentMessageCount = fixture.api.sentMessages.length;
  fixture.bridge.emit(observed('session-1', 1, 'phone prompt', 'already relayed'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.bridge.sendCalls, [{ sessionId: 'session-1', prompt: 'phone prompt' }]);
  assert.equal(fixture.api.sentMessages.length, sentMessageCount);
  assert.equal(
    fixture.api.sentMessages.some(({ text }) => text.startsWith('▶ ')),
    false,
  );
});

test('an open substrate turn rejects a phone message before bridge.send', async () => {
  const fixture = createBotFixture();
  fixture.store.bind(binding('session-1', 609));
  fixture.bridge.openTurnResult = 4;

  await fixture.bot.handleUpdate(topicUpdate('phone prompt', 609));

  assert.equal(fixture.bridge.sendCalls.length, 0);
  assert.equal(fixture.api.sentMessages.at(-1)?.text, 'still working on the previous turn');
});

test('/stop unsubscribes the bound session and suppresses later observations', async () => {
  const fixture = createBotFixture();
  fixture.store.bind(binding('session-1', 610));
  fixture.bot.start();

  await fixture.bot.handleUpdate(topicUpdate('/stop', 610));
  const sentMessageCount = fixture.api.sentMessages.length;
  fixture.bridge.emit(observed('session-1', 5, 'after stop', 'hidden'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.bridge.stopCalls, ['session-1']);
  assert.deepEqual(fixture.bridge.unsubscribeCalls, ['session-1']);
  assert.equal(fixture.api.sentMessages.length, sentMessageCount);
});
