import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTelegramBot, type TelegramBot, type TelegramFormat } from '../src/telegram/bot.js';
import {
  getTelegramApiBase,
  getTelegramProvider,
  loadTelegramConfig,
} from '../src/telegram/config.js';
import { openTopicStore } from '../src/telegram/store.js';
import type {
  CallbackQuery,
  IncomingMessage,
  MachineSessionLite,
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
type TopicParams = Parameters<TelegramApi['createForumTopic']>[0];
type WatchParams = Parameters<SessionBridge['watchTurn']>[0];
type Project = { name: string; path: string };
type SentMessage = SendMessageParams & { messageId: number };

class FakeApi implements TelegramApi {
  readonly calls: string[] = [];
  readonly sentMessages: SentMessage[] = [];
  readonly editedMessages: EditMessageParams[] = [];
  readonly documents: DocumentParams[] = [];
  readonly createdTopics: TopicParams[] = [];
  private nextMessageId = 100;
  private nextThreadId = 500;
  async getMe(): Promise<{ id: number; username: string }> {
    this.calls.push('getMe');
    return { id: 1, username: 'test-bot' };
  }

  async getUpdates(
    offset: number,
    timeoutSec: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    void offset;
    void timeoutSec;
    void signal;
    this.calls.push('getUpdates');
    return [];
  }

  async sendMessage(params: SendMessageParams): Promise<{ messageId: number }> {
    this.calls.push('sendMessage');
    this.nextMessageId += 1;
    const messageId = this.nextMessageId;
    this.sentMessages.push({ ...params, messageId });
    return { messageId };
  }

  async editMessageText(params: EditMessageParams): Promise<void> {
    this.calls.push('editMessageText');
    this.editedMessages.push(params);
  }
  async editMessageReplyMarkup(): Promise<void> {
    this.calls.push('editMessageReplyMarkup');
  }

  async sendDocument(params: DocumentParams): Promise<{ messageId: number }> {
    this.calls.push('sendDocument');
    this.documents.push(params);
    this.nextMessageId += 1;
    return { messageId: this.nextMessageId };
  }

  async createForumTopic(params: TopicParams): Promise<{ threadId: number }> {
    this.calls.push('createForumTopic');
    this.createdTopics.push(params);
    this.nextThreadId += 1;
    return { threadId: this.nextThreadId };
  }
  async editForumTopic(): Promise<void> {
    this.calls.push('editForumTopic');
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    void text;
    this.calls.push(`answerCallbackQuery:${id}`);
  }
  getFile = (): Promise<{ filePath: string }> => Promise.reject(new Error('unused'));
  downloadFile = (): Promise<Uint8Array> => Promise.reject(new Error('unused'));
}

class FakeBridge implements SessionBridge {
  projectsList: Project[] = [{ name: 'demo', path: '/tmp/demo' }];
  healthResult = true;
  readonly projectCalls: number[] = [];
  readonly openCalls: Array<{ cwd: string; prompt: string; project?: string }> = [];
  readonly sendCalls: Array<{ sessionId: string; prompt: string }> = [];
  readonly stopCalls: string[] = [];
  readonly renameCalls: Array<{ sessionId: string; label: string }> = [];
  readonly watchCalls: WatchParams[] = [];
  sessions: SessionLite[] = [{ sessionId: 'session-1', status: 'live', cwd: '/tmp/demo' }];
  watchTurnHandler: ((params: WatchParams) => Promise<TurnResult>) | undefined;
  async health(): Promise<boolean> {
    return this.healthResult;
  }
  transcribe = (): Promise<{ text: string }> => Promise.reject(new Error('unused'));
  async projects(): Promise<Project[]> {
    this.projectCalls.push(1);
    return this.projectsList;
  }

  async open(params: { cwd: string; prompt: string; project?: string }): Promise<{
    sessionId: string;
    turn: number;
  }> {
    this.openCalls.push(params);
    return { sessionId: 'session-1', turn: 1 };
  }
  machineSessions = (): Promise<MachineSessionLite[]> => Promise.resolve([]);
  subscribeSession = (): (() => void) => () => undefined;
  openTurn = (): Promise<number | null> => Promise.resolve(null);
  async resume(): Promise<{ sessionId: string; turn: number }> {
    return { sessionId: 'unused', turn: 1 };
  }

  async send(params: { sessionId: string; prompt: string }): Promise<{ turn: number }> {
    this.sendCalls.push(params);
    return { turn: this.sendCalls.length + 1 };
  }

  async stop(sessionId: string): Promise<boolean> {
    this.stopCalls.push(sessionId);
    return true;
  }
  async rename(params: { sessionId: string; label: string }): Promise<void> {
    this.renameCalls.push(params);
  }

  list = (): Promise<SessionLite[]> => Promise.resolve(this.sessions);

  async watchTurn(params: WatchParams): Promise<TurnResult> {
    this.watchCalls.push(params);
    if (this.watchTurnHandler) return this.watchTurnHandler(params);
    params.onProgress({ elapsedMs: 1_000, toolCalls: 1 });
    return { status: 'complete', text: 'done', elapsedMs: 1_000, toolCalls: 1 };
  }
}

const format: TelegramFormat = {
  escapeMarkdownV2: (text) => text,
  chunkText: (text) => [text || '(no output)'],
};

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

function temporaryStore(): { store: TopicStore; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-'));
  return {
    store: openTopicStore(path.join(directory, 'telegram.sqlite')),
    directory,
  };
}

function message(
  text: string,
  options: Partial<Pick<IncomingMessage, 'chatId' | 'threadId' | 'isTopicMessage' | 'from'>> = {},
): IncomingMessage {
  return {
    chatId: options.chatId ?? -1001,
    messageId: 1,
    from: options.from ?? { id: 42 },
    text,
    isTopicMessage: options.isTopicMessage ?? false,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
  };
}

function update(incoming: IncomingMessage): TelegramUpdate {
  return { updateId: incoming.messageId, message: incoming };
}

function topicBinding(threadId = 600): TopicBinding {
  return {
    threadId,
    sessionId: 'session-1',
    label: 'demo · hello',
    createdAt: new Date(0).toISOString(),
  };
}

function createFixture(): {
  api: FakeApi;
  bridge: FakeBridge;
  store: TopicStore;
  directory: string;
  bot: TelegramBot;
} {
  const api = new FakeApi();
  const bridge = new FakeBridge();
  const temporary = temporaryStore();
  const bot = createTelegramBot({ api, bridge, store: temporary.store, config: config(), format });
  return { api, bridge, store: temporary.store, directory: temporary.directory, bot };
}

function cleanup(store: TopicStore, directory: string): void {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

test('Telegram config validates required values and applies defaults', () => {
  const loaded = loadTelegramConfig({
    VIBECODIUM_TELEGRAM_TOKEN: ' token ',
    VIBECODIUM_TELEGRAM_USER_ID: '42',
    VIBECODIUM_TELEGRAM_CHAT_ID: '-1001',
  });
  assert.equal(loaded.token, 'token');
  assert.equal(loaded.controlPlaneUrl, 'http://127.0.0.1:4310');
  assert.equal(loaded.dbPath, '.vibecodium/telegram.sqlite');
  assert.equal(loaded.progressThrottleMs, 5_000);
  assert.equal(getTelegramApiBase({}), 'https://api.telegram.org');
  assert.equal(getTelegramProvider({}), 'omp');
  assert.equal(getTelegramProvider({ VIBECODIUM_TELEGRAM_PROVIDER: ' fake ' }), 'fake');
  assert.equal(
    getTelegramApiBase({ VIBECODIUM_TELEGRAM_API_BASE: 'http://stub/' }),
    'http://stub/',
  );
  assert.throws(
    () => loadTelegramConfig({ VIBECODIUM_TELEGRAM_USER_ID: 'not-an-id' }),
    /VIBECODIUM_TELEGRAM_TOKEN.*VIBECODIUM_TELEGRAM_USER_ID.*VIBECODIUM_TELEGRAM_CHAT_ID/,
  );
});

test('topic store persists bindings and update offsets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-store-'));
  const filename = path.join(directory, 'nested', 'telegram.sqlite');
  const first = openTopicStore(filename);
  first.bind(topicBinding(77));
  first.setOffset(19);
  assert.deepEqual(first.byThread(77), topicBinding(77));
  assert.equal(first.getOffset(), 19);
  first.close();
  const second = openTopicStore(filename);
  assert.deepEqual(second.all(), [topicBinding(77)]);
  assert.equal(second.getOffset(), 19);
  second.unbind(77);
  assert.equal(second.byThread(77), null);
  second.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('foreign users are dropped without any API call', async () => {
  const fixture = createFixture();
  try {
    await fixture.bot.handleUpdate(
      update(message('/new demo hello', { from: { id: 999 }, chatId: -1001 })),
    );
    assert.deepEqual(fixture.api.calls, []);
    assert.deepEqual(fixture.bridge.openCalls, []);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('/new project prompt creates a topic, opens a session, and binds it', async () => {
  const fixture = createFixture();
  try {
    await fixture.bot.handleUpdate(update(message('/new demo hello world')));
    assert.deepEqual(fixture.api.createdTopics, [{ chatId: -1001, name: 'demo · hello world' }]);
    assert.deepEqual(fixture.bridge.openCalls, [
      { cwd: '/tmp/demo', prompt: 'hello world', project: 'demo' },
    ]);
    const binding = fixture.store.byThread(501);
    assert.ok(binding);
    assert.equal(binding.sessionId, 'session-1');
    assert.equal(fixture.api.sentMessages.at(-1)?.threadId, 501);
    assert.ok(
      fixture.api.sentMessages.some(
        ({ text, threadId }) => text === 'working… 0s' && threadId === 501,
      ),
    );
    const workingMessage = fixture.api.sentMessages.find(
      ({ text, threadId }) => text === 'working… 0s' && threadId === 501,
    );
    assert.ok(workingMessage);
    assert.equal(fixture.bridge.watchCalls.at(-1)?.turn, 1);
    assert.ok(fixture.api.editedMessages.some(({ text }) => text.startsWith('working…')));
    assert.equal(fixture.api.editedMessages.at(-1)?.text, 'done');
    assert.equal(fixture.api.editedMessages.at(-1)?.messageId, workingMessage.messageId);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('/new without a project presents buttons and consumes the next prompt', async () => {
  const fixture = createFixture();
  try {
    await fixture.bot.handleUpdate(update(message('/new')));
    const keyboard = fixture.api.sentMessages.at(-1)?.buttons;
    assert.deepEqual(keyboard, [[{ text: 'demo', callbackData: 'new:demo' }]]);
    const callback: CallbackQuery = {
      id: 'callback-1',
      from: { id: 42 },
      data: 'new:demo',
      message: { chatId: -1001, messageId: 2 },
    };
    await fixture.bot.handleUpdate({ updateId: 2, callbackQuery: callback });
    assert.ok(fixture.api.calls.includes('answerCallbackQuery:callback-1'));
    assert.match(fixture.api.sentMessages.at(-1)?.text ?? '', /first prompt/);
    await fixture.bot.handleUpdate(update(message('first prompt')));
    assert.deepEqual(fixture.bridge.openCalls, [
      { cwd: '/tmp/demo', prompt: 'first prompt', project: 'demo' },
    ]);
    assert.ok(fixture.store.byThread(501));
    assert.deepEqual(fixture.api.createdTopics, [{ chatId: -1001, name: 'demo · first prompt' }]);
    assert.ok(
      fixture.api.sentMessages.some(
        ({ text, threadId }) => text === 'working… 0s' && threadId === 501,
      ),
    );
    const workingMessage = fixture.api.sentMessages.find(
      ({ text, threadId }) => text === 'working… 0s' && threadId === 501,
    );
    assert.ok(workingMessage);
    assert.equal(fixture.bridge.watchCalls.at(-1)?.turn, 1);
    assert.ok(fixture.api.editedMessages.some(({ text }) => text.startsWith('working…')));
    assert.equal(fixture.api.editedMessages.at(-1)?.text, 'done');
    assert.equal(fixture.api.editedMessages.at(-1)?.messageId, workingMessage.messageId);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('topic text sends a turn, throttles progress, and edits the final text', async () => {
  const fixture = createFixture();
  const binding = topicBinding();
  fixture.store.bind(binding);
  try {
    await fixture.bot.handleUpdate(
      update(message('please continue', { threadId: binding.threadId, isTopicMessage: true })),
    );
    assert.deepEqual(fixture.bridge.sendCalls, [
      { sessionId: 'session-1', prompt: 'please continue' },
    ]);
    assert.equal(fixture.api.sentMessages[0]?.text, 'working… 0s');
    assert.ok(fixture.api.editedMessages.length >= 2);
    assert.equal(fixture.api.editedMessages.at(-1)?.text, 'done');
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('long turn results are sent as a Markdown document', async () => {
  const fixture = createFixture();
  const binding = topicBinding(601);
  fixture.store.bind(binding);
  const longFormat: TelegramFormat = {
    escapeMarkdownV2: (text) => text,
    chunkText: (text) => [text, 'two', 'three', 'four'],
  };
  const bot = createTelegramBot({
    api: fixture.api,
    bridge: fixture.bridge,
    store: fixture.store,
    config: config(),
    format: longFormat,
  });
  try {
    await bot.handleUpdate(
      update(message('long result', { threadId: binding.threadId, isTopicMessage: true })),
    );
    assert.equal(fixture.api.documents.length, 1);
    assert.deepEqual(fixture.api.documents[0], {
      chatId: -1001,
      threadId: binding.threadId,
      filename: 'turn-2.md',
      content: 'done',
    });
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('/stop and /attach operate on the bound session', async () => {
  const fixture = createFixture();
  const binding = topicBinding(602);
  fixture.store.bind(binding);
  try {
    await fixture.bot.handleUpdate(
      update(message('/stop', { threadId: binding.threadId, isTopicMessage: true })),
    );
    await fixture.bot.handleUpdate(
      update(message('/attach', { threadId: binding.threadId, isTopicMessage: true })),
    );
    assert.deepEqual(fixture.bridge.stopCalls, ['session-1']);
    assert.match(fixture.api.sentMessages.at(-1)?.text ?? '', /vibecodium attach session-1/);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('a bridge health failure is reported without escaping the handler', async () => {
  const fixture = createFixture();
  fixture.bridge.healthResult = false;
  try {
    await fixture.bot.handleUpdate(update(message('/sessions')));
    assert.match(fixture.api.sentMessages.at(-1)?.text ?? '', /^control plane unresponsive:/);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('a new topic queues messages while its first turn is running', async () => {
  const fixture = createFixture();
  let resolveTurn: ((result: TurnResult) => void) | undefined;
  let watchStartedResolve: (() => void) | undefined;
  const watchStarted = new Promise<void>((resolve) => {
    watchStartedResolve = resolve;
  });
  const turnPending = new Promise<TurnResult>((resolve) => {
    resolveTurn = resolve;
  });
  fixture.bridge.watchTurnHandler = async (params) => {
    params.onProgress({ elapsedMs: 1_000, toolCalls: 1 });
    watchStartedResolve?.();
    return turnPending;
  };
  try {
    const first = fixture.bot.handleUpdate(update(message('/new demo first')));
    await watchStarted;
    await fixture.bot.handleUpdate(
      update(message('second', { threadId: 501, isTopicMessage: true })),
    );
    assert.equal(fixture.bridge.sendCalls.length, 0);
    assert.ok(fixture.api.sentMessages.some(({ text }) => text === 'queued (#1)'));
    resolveTurn?.({ status: 'complete', text: 'done', elapsedMs: 1_000, toolCalls: 1 });
    await first;
    assert.equal(fixture.bridge.sendCalls.map((call) => call.prompt).join('|'), 'second');
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});
test('a second topic message while a turn is running is queued and drained in order', async () => {
  const fixture = createFixture();
  const binding = topicBinding(603);
  fixture.store.bind(binding);
  let resolveTurn: ((result: TurnResult) => void) | undefined;
  let watchStartedResolve: (() => void) | undefined;
  const watchStarted = new Promise<void>((resolve) => {
    watchStartedResolve = resolve;
  });
  const turnPending = new Promise<TurnResult>((resolve) => {
    resolveTurn = resolve;
  });
  fixture.bridge.watchTurnHandler = async (params) => {
    params.onProgress({ elapsedMs: 1_000, toolCalls: 1 });
    watchStartedResolve?.();
    return turnPending;
  };
  try {
    const first = fixture.bot.handleUpdate(
      update(message('first', { threadId: binding.threadId, isTopicMessage: true })),
    );
    await watchStarted;
    await fixture.bot.handleUpdate(
      update(message('second', { threadId: binding.threadId, isTopicMessage: true })),
    );
    assert.equal(fixture.bridge.sendCalls.length, 1);
    assert.ok(fixture.api.sentMessages.some(({ text }) => text === 'queued (#1)'));
    resolveTurn?.({ status: 'complete', text: 'done', elapsedMs: 1_000, toolCalls: 1 });
    await first;
    assert.equal(fixture.bridge.sendCalls.map((call) => call.prompt).join('|'), 'first|second');
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});
