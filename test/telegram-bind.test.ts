import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTelegramBot, type TelegramBot, type TelegramFormat } from '../src/telegram/bot.js';
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
  TopicStore,
  TurnResult,
} from '../src/telegram/types.js';

type SendMessageParams = Parameters<TelegramApi['sendMessage']>[0];
type EditMessageParams = Parameters<TelegramApi['editMessageText']>[0];
type EditMarkupParams = Parameters<TelegramApi['editMessageReplyMarkup']>[0];
type TopicParams = Parameters<TelegramApi['createForumTopic']>[0];
type WatchParams = Parameters<SessionBridge['watchTurn']>[0];
type SentMessage = SendMessageParams & { messageId: number };

class FakeApi implements TelegramApi {
  readonly sentMessages: SentMessage[] = [];
  readonly editedMessages: EditMessageParams[] = [];
  readonly editedMarkups: EditMarkupParams[] = [];
  readonly createdTopics: TopicParams[] = [];
  private nextMessageId = 100;
  private nextThreadId = 500;

  async getMe(): Promise<{ id: number; username: string }> {
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

  async editMessageReplyMarkup(params: EditMarkupParams): Promise<void> {
    this.editedMarkups.push(params);
  }

  async sendDocument(): Promise<{ messageId: number }> {
    this.nextMessageId += 1;
    return { messageId: this.nextMessageId };
  }

  async createForumTopic(params: TopicParams): Promise<{ threadId: number }> {
    this.createdTopics.push(params);
    this.nextThreadId += 1;
    return { threadId: this.nextThreadId };
  }

  async editForumTopic(): Promise<void> {}

  async answerCallbackQuery(): Promise<void> {}
}

class FakeBridge implements SessionBridge {
  substrateSessions: SessionLite[] = [];
  machineSessionsList: MachineSessionLite[] = [];
  readonly openCalls: Array<{ cwd: string; prompt: string; project?: string }> = [];
  readonly resumeCalls: Array<{
    source: 'omp' | 'codex';
    ref: string;
    prompt: string;
    cwd?: string;
  }> = [];
  readonly sendCalls: Array<{ sessionId: string; prompt: string }> = [];
  readonly watchCalls: WatchParams[] = [];

  async health(): Promise<boolean> {
    return true;
  }

  async projects(): Promise<Array<{ name: string; path: string }>> {
    return [];
  }

  async open(params: { cwd: string; prompt: string; project?: string }): Promise<{
    sessionId: string;
    turn: number;
  }> {
    this.openCalls.push(params);
    return { sessionId: 'opened', turn: 1 };
  }

  async machineSessions(): Promise<MachineSessionLite[]> {
    return this.machineSessionsList;
  }

  async resume(params: {
    source: 'omp' | 'codex';
    ref: string;
    prompt: string;
    cwd?: string;
  }): Promise<{ sessionId: string; turn: number }> {
    this.resumeCalls.push(params);
    return { sessionId: 'resumed', turn: 1 };
  }

  async send(params: { sessionId: string; prompt: string }): Promise<{ turn: number }> {
    this.sendCalls.push(params);
    return { turn: 1 };
  }

  async stop(): Promise<boolean> {
    return true;
  }

  async rename(): Promise<void> {}

  async list(): Promise<SessionLite[]> {
    return this.substrateSessions;
  }

  subscribeSession(): () => void {
    return () => undefined;
  }

  openTurn(): Promise<number | null> {
    return Promise.resolve(null);
  }

  async watchTurn(params: WatchParams): Promise<TurnResult> {
    this.watchCalls.push(params);
    return { status: 'complete', text: 'unused', elapsedMs: 1, toolCalls: 0 };
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

function session(sessionId: string, status: 'live' | 'resumable', label?: string): SessionLite {
  return {
    sessionId,
    status,
    ...(label === undefined ? {} : { label }),
    cwd: `/workspace/${sessionId}`,
    prompt: `Prompt for ${sessionId}`,
    updatedAt: new Date().toISOString(),
  };
}

function machine(ref: string): MachineSessionLite {
  return {
    source: 'omp',
    ref,
    title: `Machine ${ref}`,
    cwd: `/workspace/${ref}`,
    updatedAt: new Date().toISOString(),
  };
}

function message(text: string): IncomingMessage {
  return {
    chatId: -1001,
    messageId: 1,
    from: { id: 42 },
    text,
    isTopicMessage: false,
  };
}

function update(incoming: IncomingMessage): TelegramUpdate {
  return { updateId: incoming.messageId, message: incoming };
}

function callback(data: string, messageId: number): CallbackQuery {
  return {
    id: `callback-${data}`,
    from: { id: 42 },
    data,
    message: { chatId: -1001, messageId },
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-bind-'));
  const store = openTopicStore(path.join(directory, 'telegram.sqlite'));
  const bot = createTelegramBot({ api, bridge, store, config: config(), format });
  return { api, bridge, store, directory, bot };
}

function cleanup(fixture: { store: TopicStore; directory: string }): void {
  fixture.store.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

function bindChoice(api: FakeApi): SentMessage {
  const choice = api.sentMessages.find((sent) =>
    sent.buttons?.some((row) => row[0]?.callbackData.startsWith('bind:')),
  );
  assert.ok(choice);
  return choice;
}

test('/resume puts live substrate sessions before machine transcripts', async () => {
  const fixture = createFixture();
  fixture.bridge.substrateSessions = [session('live-1', 'live', 'Live topic')];
  fixture.bridge.machineSessionsList = [machine('machine-1')];
  try {
    await fixture.bot.handleUpdate(update(message('/resume')));
    const substrateIndex = fixture.api.sentMessages.findIndex((sent) =>
      sent.buttons?.some((row) => row[0]?.callbackData.startsWith('bind:')),
    );
    const machineIndex = fixture.api.sentMessages.findIndex((sent) =>
      sent.buttons?.some((row) => row[0]?.callbackData.startsWith('resume:')),
    );
    assert.ok(substrateIndex >= 0);
    assert.ok(machineIndex > substrateIndex);
    assert.match(fixture.api.sentMessages[substrateIndex]?.buttons?.[0]?.[0]?.text ?? '', /^● /);
  } finally {
    cleanup(fixture);
  }
});

test('picking a substrate session binds without sending a prompt or relaying a turn', async () => {
  const fixture = createFixture();
  fixture.bridge.substrateSessions = [session('live-1', 'live', 'Live topic')];
  try {
    await fixture.bot.handleUpdate(update(message('/resume')));
    const choice = bindChoice(fixture.api);
    const button = choice.buttons
      ?.flat()
      .find((candidate) => candidate.callbackData.startsWith('bind:'));
    assert.ok(button);
    await fixture.bot.handleUpdate({
      updateId: 2,
      callbackQuery: callback(button.callbackData, choice.messageId),
    });
    assert.deepEqual(fixture.api.createdTopics, [{ chatId: -1001, name: 'Live topic' }]);
    assert.deepEqual(fixture.store.bySession('live-1'), {
      threadId: 501,
      sessionId: 'live-1',
      label: 'Live topic',
      createdAt: fixture.store.bySession('live-1')?.createdAt,
    });
    assert.equal(fixture.api.sentMessages.at(-1)?.text, 'bound to session live-1');
    assert.equal(fixture.api.sentMessages.at(-1)?.threadId, 501);
    assert.deepEqual(fixture.bridge.openCalls, []);
    assert.deepEqual(fixture.bridge.resumeCalls, []);
    assert.deepEqual(fixture.bridge.sendCalls, []);
    assert.deepEqual(fixture.bridge.watchCalls, []);
  } finally {
    cleanup(fixture);
  }
});

test('picking an already-bound substrate session does not create another topic', async () => {
  const fixture = createFixture();
  fixture.bridge.substrateSessions = [session('live-1', 'resumable', 'Live topic')];
  fixture.store.bind({
    threadId: 700,
    sessionId: 'live-1',
    label: 'Existing topic',
    createdAt: new Date().toISOString(),
  });
  try {
    await fixture.bot.handleUpdate(update(message('/resume')));
    const choice = bindChoice(fixture.api);
    const button = choice.buttons
      ?.flat()
      .find((candidate) => candidate.callbackData.startsWith('bind:'));
    assert.ok(button);
    await fixture.bot.handleUpdate({
      updateId: 2,
      callbackQuery: callback(button.callbackData, choice.messageId),
    });
    assert.equal(fixture.api.createdTopics.length, 0);
    assert.equal(fixture.api.sentMessages.at(-1)?.text, 'already bound to topic "Existing topic"');
  } finally {
    cleanup(fixture);
  }
});

test('/sessions shows bound topics and bind buttons for unbound sessions', async () => {
  const fixture = createFixture();
  fixture.bridge.substrateSessions = [
    session('bound-1', 'live', 'Bound session'),
    session('free-1', 'resumable', 'Free session'),
  ];
  fixture.store.bind({
    threadId: 701,
    sessionId: 'bound-1',
    label: 'Topic label',
    createdAt: new Date().toISOString(),
  });
  try {
    await fixture.bot.handleUpdate(update(message('/sessions')));
    const sent = fixture.api.sentMessages.at(-1);
    assert.ok(sent);
    assert.match(sent.text, /bound → Topic label/);
    const bindButton = sent.buttons?.flat().find((button) => button.text === 'bind');
    assert.ok(bindButton);
    assert.match(bindButton.callbackData, /^bind:\d+:0$/);
  } finally {
    cleanup(fixture);
  }
});

test('a bind callback with a stale snapshot is rejected', async () => {
  const fixture = createFixture();
  fixture.bridge.substrateSessions = [session('live-1', 'live')];
  try {
    await fixture.bot.handleUpdate(update(message('/resume')));
    const choice = bindChoice(fixture.api);
    await fixture.bot.handleUpdate({
      updateId: 2,
      callbackQuery: callback('bind:999:0', choice.messageId),
    });
    assert.equal(fixture.api.sentMessages.at(-1)?.text, 'that session selection is invalid');
  } finally {
    cleanup(fixture);
  }
});
