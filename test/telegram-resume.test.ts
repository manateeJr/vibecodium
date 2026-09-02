import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildResumeKeyboard, formatSessionAge, truncateTitle } from '../src/telegram/resume.js';
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
type TopicParams = Parameters<TelegramApi['createForumTopic']>[0];
type WatchParams = Parameters<SessionBridge['watchTurn']>[0];
type SentMessage = SendMessageParams & { messageId: number };

class FakeApi implements TelegramApi {
  readonly sentMessages: SentMessage[] = [];
  readonly editedMessages: EditMessageParams[] = [];
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

  async sendDocument(): Promise<{ messageId: number }> {
    this.nextMessageId += 1;
    return { messageId: this.nextMessageId };
  }

  async createForumTopic(params: TopicParams): Promise<{ threadId: number }> {
    this.createdTopics.push(params);
    this.nextThreadId += 1;
    return { threadId: this.nextThreadId };
  }

  async answerCallbackQuery(): Promise<void> {}
}

class FakeBridge implements SessionBridge {
  machineSessionsList: MachineSessionLite[] = [];
  readonly resumeCalls: Array<{
    source: 'omp' | 'codex';
    ref: string;
    prompt: string;
    cwd?: string;
  }> = [];
  readonly machineSessionsCalls: number[] = [];
  readonly watchCalls: WatchParams[] = [];
  resumeError: Error | undefined;
  resumeResult = { sessionId: 'resumed-session', turn: 1 };

  async health(): Promise<boolean> {
    return true;
  }

  async projects(): Promise<Array<{ name: string; path: string }>> {
    return [];
  }

  async open(): Promise<{ sessionId: string; turn: number }> {
    return { sessionId: 'unused', turn: 1 };
  }

  async machineSessions(): Promise<MachineSessionLite[]> {
    this.machineSessionsCalls.push(1);
    return this.machineSessionsList;
  }

  async resume(params: {
    source: 'omp' | 'codex';
    ref: string;
    prompt: string;
    cwd?: string;
  }): Promise<{ sessionId: string; turn: number }> {
    this.resumeCalls.push(params);
    if (this.resumeError) throw this.resumeError;
    return this.resumeResult;
  }

  async send(): Promise<{ turn: number }> {
    return { turn: 1 };
  }

  async stop(): Promise<boolean> {
    return true;
  }

  async list(): Promise<SessionLite[]> {
    return [];
  }

  async watchTurn(params: WatchParams): Promise<TurnResult> {
    this.watchCalls.push(params);
    params.onProgress({ elapsedMs: 1_000, toolCalls: 1 });
    return { status: 'complete', text: 'resumed turn one', elapsedMs: 1_000, toolCalls: 1 };
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-resume-'));
  return {
    store: openTopicStore(path.join(directory, 'telegram.sqlite')),
    directory,
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

function callback(data: string): CallbackQuery {
  return {
    id: `callback-${data}`,
    from: { id: 42 },
    data,
    message: { chatId: -1001, messageId: 2 },
  };
}

function session(
  ref: string,
  title: string,
  cwd: string,
  updatedAt: string,
  source: 'omp' | 'codex' = 'omp',
): MachineSessionLite {
  return { source, ref, title, cwd, updatedAt };
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

function threeMinutesAgo(): string {
  return new Date(Date.now() - 3 * 60_000 - 500).toISOString();
}

test('resume helpers format age, truncate titles, and build five callbacks', () => {
  const now = new Date('2026-09-02T12:00:00.000Z');
  const sessions = [
    session('one', 'a'.repeat(50), '/workspace/one', '2026-09-02T11:57:00.000Z'),
    session('two', 'two hours', '/workspace/two', '2026-09-02T10:00:00.000Z'),
    session('three', 'one day', '/workspace/three', '2026-09-01T12:00:00.000Z'),
    session('four', 'four', '/workspace/four', now.toISOString()),
    session('five', 'five', '/workspace/five', now.toISOString()),
    session('six', 'six', '/workspace/six', now.toISOString()),
  ];
  const keyboard = buildResumeKeyboard(sessions, now);
  const [first, second, third] = sessions;
  assert.ok(first && second && third);
  assert.equal(formatSessionAge(first.updatedAt, now), '3m');
  assert.equal(formatSessionAge(second.updatedAt, now), '2h');
  assert.equal(formatSessionAge(third.updatedAt, now), '1d');
  assert.equal(truncateTitle(first.title, 40), 'a'.repeat(40));
  assert.equal(keyboard.length, 5);
  assert.deepEqual(
    keyboard.map(([button]) => button?.callbackData),
    ['resume:0', 'resume:1', 'resume:2', 'resume:3', 'resume:4'],
  );
  assert.equal(keyboard[0]?.[0]?.text, `${'a'.repeat(40)} · one · 3m`);
  assert.equal(keyboard[1]?.[0]?.text, 'two hours · two · 2h');
  assert.equal(keyboard[2]?.[0]?.text, 'one day · three · 1d');
});

test('resume callback starts a new topic and relays the first turn', async () => {
  const fixture = createFixture();
  const title = 'A title that is deliberately longer than sixty characters for truncation';
  fixture.bridge.machineSessionsList = [
    session('machine-ref', title, '/workspace/resume', threeMinutesAgo()),
  ];
  try {
    await fixture.bot.handleUpdate(update(message('/resume')));
    await fixture.bot.handleUpdate({ updateId: 2, callbackQuery: callback('resume:0') });
    assert.equal(
      fixture.api.sentMessages.at(-1)?.text,
      `send the first prompt to continue "${title}"`,
    );

    await fixture.bot.handleUpdate(update(message('continue this work')));
    assert.deepEqual(fixture.bridge.resumeCalls, [
      {
        source: 'omp',
        ref: 'machine-ref',
        prompt: 'continue this work',
        cwd: '/workspace/resume',
      },
    ]);
    assert.deepEqual(fixture.api.createdTopics, [{ chatId: -1001, name: title.slice(0, 60) }]);
    const binding = fixture.store.byThread(501);
    assert.ok(binding);
    assert.equal(binding.sessionId, 'resumed-session');
    assert.ok(
      fixture.api.sentMessages.some(
        ({ text, threadId }) =>
          text === 'session resumed-session resumed from omp' && threadId === 501,
      ),
    );
    const workingMessage = fixture.api.sentMessages.find(
      ({ text, threadId }) => text === 'working… 0s' && threadId === 501,
    );
    assert.ok(workingMessage);
    assert.equal(fixture.bridge.watchCalls.at(-1)?.turn, 1);
    assert.equal(fixture.api.editedMessages.at(-1)?.text, 'resumed turn one');
    assert.equal(fixture.api.editedMessages.at(-1)?.messageId, workingMessage.messageId);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('resume ref starts the pending prompt flow without a keyboard', async () => {
  const fixture = createFixture();
  fixture.bridge.machineSessionsList = [
    session('direct-ref', 'Direct session', '/workspace/direct', threeMinutesAgo()),
  ];
  try {
    await fixture.bot.handleUpdate(update(message('/resume direct-ref')));
    assert.equal(fixture.api.sentMessages.at(-1)?.buttons, undefined);
    assert.equal(
      fixture.api.sentMessages.at(-1)?.text,
      'send the first prompt to continue "Direct session"',
    );
    await fixture.bot.handleUpdate(update(message('first prompt')));
    assert.equal(fixture.bridge.resumeCalls.length, 1);
    assert.deepEqual(fixture.bridge.resumeCalls[0], {
      source: 'omp',
      ref: 'direct-ref',
      prompt: 'first prompt',
      cwd: '/workspace/direct',
    });
    assert.equal(fixture.api.createdTopics[0]?.name, 'Direct session');
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('unknown resume refs are rejected before resume is called', async () => {
  const fixture = createFixture();
  fixture.bridge.machineSessionsList = [
    session('known-ref', 'Known', '/workspace/known', threeMinutesAgo()),
  ];
  try {
    await fixture.bot.handleUpdate(update(message('/resume missing-ref')));
    assert.equal(fixture.api.sentMessages.at(-1)?.text, 'unknown session ref');
    assert.equal(fixture.bridge.resumeCalls.length, 0);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('empty machine sessions return an exact empty-state reply', async () => {
  const fixture = createFixture();
  try {
    await fixture.bot.handleUpdate(update(message('/resume')));
    assert.equal(fixture.api.sentMessages.at(-1)?.text, 'no machine sessions found');
    assert.equal(fixture.api.sentMessages.at(-1)?.buttons, undefined);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('resume errors are reported verbatim without the generic error prefix', async () => {
  const fixture = createFixture();
  fixture.bridge.machineSessionsList = [
    session('busy-ref', 'Busy session', '/workspace/busy', threeMinutesAgo()),
  ];
  fixture.bridge.resumeError = new Error('external session appears active; attach instead');
  try {
    await fixture.bot.handleUpdate(update(message('/resume busy-ref')));
    await fixture.bot.handleUpdate(update(message('try to continue')));
    assert.equal(
      fixture.api.sentMessages.at(-1)?.text,
      'resume failed: external session appears active; attach instead',
    );
    assert.ok(!fixture.api.sentMessages.at(-1)?.text.startsWith('control plane unresponsive: '));
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('/help includes the resume command', async () => {
  const fixture = createFixture();
  try {
    await fixture.bot.handleUpdate(update(message('/help')));
    assert.match(fixture.api.sentMessages.at(-1)?.text ?? '', /\/resume/);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});
