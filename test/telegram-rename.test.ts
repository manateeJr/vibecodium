import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramBot } from '../src/telegram/bot.js';
import { handleRenameCommand, RENAME_GENERAL_REPLY } from '../src/telegram/rename.js';
import type {
  SessionBridge,
  TelegramApi,
  TopicBinding,
  TopicStore,
} from '../src/telegram/types.js';

type SendMessageParams = Parameters<TelegramApi['sendMessage']>[0];
type EditForumTopicParams = Parameters<TelegramApi['editForumTopic']>[0];
type RenameParams = Parameters<SessionBridge['rename']>[0];

type Fixture = {
  api: FakeApi;
  bridge: FakeBridge;
  store: FakeStore;
};

class FakeApi {
  readonly calls: string[];
  readonly sentMessages: SendMessageParams[] = [];
  readonly editedTopics: EditForumTopicParams[] = [];

  constructor(calls: string[]) {
    this.calls = calls;
  }

  async sendMessage(params: SendMessageParams): Promise<{ messageId: number }> {
    this.calls.push('api.sendMessage');
    this.sentMessages.push(params);
    return { messageId: this.sentMessages.length };
  }

  async editForumTopic(params: EditForumTopicParams): Promise<void> {
    this.calls.push('api.editForumTopic');
    this.editedTopics.push(params);
  }
}

class FakeBridge {
  readonly calls: string[];
  readonly renameCalls: RenameParams[] = [];
  failRename = false;

  constructor(calls: string[]) {
    this.calls = calls;
  }

  async rename(params: RenameParams): Promise<void> {
    this.calls.push('bridge.rename');
    this.renameCalls.push(params);
    if (this.failRename) throw new Error('boom');
  }
  subscribeSession(): () => void {
    return () => undefined;
  }
  openTurn(): Promise<number | null> {
    return Promise.resolve(null);
  }
}

class FakeStore {
  readonly calls: string[];
  readonly renameCalls: Array<{ threadId: number; label: string }> = [];
  binding: TopicBinding | null = null;

  constructor(calls: string[]) {
    this.calls = calls;
  }
  bySession(): TopicBinding | null {
    return null;
  }

  byThread(threadId: number): TopicBinding | null {
    const binding = this.binding;
    if (binding === null || binding.threadId !== threadId) return null;
    return binding;
  }

  rename(threadId: number, label: string): void {
    this.calls.push('store.rename');
    this.renameCalls.push({ threadId, label });
  }
}

function fixture(): Fixture {
  const calls: string[] = [];
  return {
    api: new FakeApi(calls),
    bridge: new FakeBridge(calls),
    store: new FakeStore(calls),
  };
}

function createBot({ api, bridge, store }: Fixture) {
  return createTelegramBot({
    api: api as unknown as TelegramApi,
    bridge: bridge as unknown as SessionBridge,
    store: store as unknown as TopicStore,
    config: {
      token: 'token',
      allowedUserId: 42,
      chatId: -1001,
      controlPlaneUrl: 'http://127.0.0.1:4310',
      dbPath: ':memory:',
      pollTimeoutSec: 50,
      progressThrottleMs: 5_000,
      turnTimeoutMs: 30 * 60 * 1_000,
    },
    format: {
      escapeMarkdownV2: (text) => text,
      chunkText: (text) => [text],
    },
  });
}

const context = {
  chatId: -1001,
  threadId: 42,
  sessionId: 'session-7',
};

test('/rename updates the bridge, topic, and store in order', async () => {
  const { api, bridge, store } = fixture();

  await handleRenameCommand(
    { api, bridge, store },
    { ...context, argumentText: 'new session name' },
  );

  assert.deepEqual(bridge.renameCalls, [{ sessionId: 'session-7', label: 'new session name' }]);
  assert.deepEqual(api.editedTopics, [{ chatId: -1001, threadId: 42, name: 'new session name' }]);
  assert.deepEqual(store.renameCalls, [{ threadId: 42, label: 'new session name' }]);
  assert.deepEqual(api.sentMessages, [
    { chatId: -1001, threadId: 42, text: 'renamed to "new session name"' },
  ]);
  assert.deepEqual(api.calls, [
    'bridge.rename',
    'api.editForumTopic',
    'store.rename',
    'api.sendMessage',
  ]);
});

test('/rename with an empty name replies with usage and does nothing else', async () => {
  const { api, bridge, store } = fixture();

  await handleRenameCommand({ api, bridge, store }, { ...context, argumentText: '  \t  ' });

  assert.deepEqual(api.sentMessages, [
    { chatId: -1001, threadId: 42, text: 'usage: /rename <name>' },
  ]);
  assert.deepEqual(bridge.renameCalls, []);
  assert.deepEqual(api.editedTopics, []);
  assert.deepEqual(store.renameCalls, []);
});

test('/rename reports a bridge error without updating the store', async () => {
  const { api, bridge, store } = fixture();
  bridge.failRename = true;

  await handleRenameCommand({ api, bridge, store }, { ...context, argumentText: 'broken name' });

  assert.deepEqual(api.sentMessages, [
    { chatId: -1001, threadId: 42, text: 'rename failed: boom' },
  ]);
  assert.deepEqual(store.renameCalls, []);
  assert.deepEqual(api.editedTopics, []);
});

test('/rename trims surrounding whitespace before applying the name', async () => {
  const { api, bridge, store } = fixture();

  await handleRenameCommand(
    { api, bridge, store },
    { ...context, argumentText: '  focused title  ' },
  );

  assert.deepEqual(bridge.renameCalls, [{ sessionId: 'session-7', label: 'focused title' }]);
  assert.deepEqual(api.editedTopics, [{ chatId: -1001, threadId: 42, name: 'focused title' }]);
  assert.deepEqual(store.renameCalls, [{ threadId: 42, label: 'focused title' }]);
  assert.deepEqual(api.sentMessages, [
    { chatId: -1001, threadId: 42, text: 'renamed to "focused title"' },
  ]);
});

test('/rename dispatches from a bound session topic', async () => {
  const fixtureData = fixture();
  fixtureData.store.binding = {
    threadId: context.threadId,
    sessionId: context.sessionId,
    label: 'old name',
    createdAt: '1970-01-01T00:00:00.000Z',
  };
  const bot = createBot(fixtureData);

  await bot.handleUpdate({
    updateId: 1,
    message: {
      chatId: context.chatId,
      threadId: context.threadId,
      messageId: 1,
      from: { id: 42 },
      text: '/rename topic label',
      isTopicMessage: true,
    },
  });

  assert.deepEqual(fixtureData.bridge.renameCalls, [
    { sessionId: 'session-7', label: 'topic label' },
  ]);
  assert.deepEqual(fixtureData.api.editedTopics, [
    { chatId: -1001, threadId: 42, name: 'topic label' },
  ]);
  assert.deepEqual(fixtureData.store.renameCalls, [{ threadId: 42, label: 'topic label' }]);
  assert.deepEqual(fixtureData.api.sentMessages, [
    { chatId: -1001, threadId: 42, text: 'renamed to "topic label"' },
  ]);
});

test('/rename in general chat explains that a session topic is required', async () => {
  const fixtureData = fixture();
  const bot = createBot(fixtureData);

  await bot.handleUpdate({
    updateId: 1,
    message: {
      chatId: context.chatId,
      messageId: 1,
      from: { id: 42 },
      text: '/rename topic label',
      isTopicMessage: false,
    },
  });

  assert.deepEqual(fixtureData.api.sentMessages, [{ chatId: -1001, text: RENAME_GENERAL_REPLY }]);
  assert.deepEqual(fixtureData.bridge.renameCalls, []);
  assert.deepEqual(fixtureData.store.renameCalls, []);
});
