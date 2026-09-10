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
  TopicBinding,
  TopicStore,
  TurnResult,
} from '../src/telegram/types.js';

type SendMessageParams = Parameters<TelegramApi['sendMessage']>[0];
type EditMessageParams = Parameters<TelegramApi['editMessageText']>[0];
type DocumentParams = Parameters<TelegramApi['sendDocument']>[0];
type TopicParams = Parameters<TelegramApi['createForumTopic']>[0];
type WatchParams = Parameters<SessionBridge['watchTurn']>[0];
type TranscribeArgs = { audio_base64: string; mime?: string };
type Project = { name: string; path: string };
type SentMessage = SendMessageParams & { messageId: number };

interface VoiceAttachment {
  fileId: string;
  mimeType?: string;
  fileSize?: number;
}

class FakeApi implements TelegramApi {
  readonly calls: string[] = [];
  readonly sentMessages: SentMessage[] = [];
  readonly editedMessages: EditMessageParams[] = [];
  readonly fileCalls: string[] = [];
  private nextMessageId = 100;
  private nextThreadId = 500;
  filePath = 'voice/file_1.oga';
  fileBytes = new Uint8Array([1, 2, 3, 4]);
  getFileError: unknown;
  downloadError: unknown;

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
    void params;
    this.calls.push('sendDocument');
    this.nextMessageId += 1;
    return { messageId: this.nextMessageId };
  }

  async createForumTopic(params: TopicParams): Promise<{ threadId: number }> {
    void params;
    this.calls.push('createForumTopic');
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

  async getFile(fileId: string): Promise<{ filePath: string }> {
    this.fileCalls.push(`getFile:${fileId}`);
    if (this.getFileError !== undefined) throw this.getFileError;
    return { filePath: this.filePath };
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    this.fileCalls.push(`downloadFile:${filePath}`);
    if (this.downloadError !== undefined) throw this.downloadError;
    return this.fileBytes;
  }
}

class FakeBridge implements SessionBridge {
  projectsList: Project[] = [{ name: 'demo', path: '/tmp/demo' }];
  healthResult = true;
  readonly transcribeCalls: TranscribeArgs[] = [];
  transcribeText = 'hello from voice';
  transcribeError: unknown;

  async health(): Promise<boolean> {
    return this.healthResult;
  }

  async projects(): Promise<Project[]> {
    return this.projectsList;
  }

  async open(params: { cwd: string; prompt: string; project?: string }): Promise<{
    sessionId: string;
    turn: number;
  }> {
    this.openCalls.push(params);
    return { sessionId: 'session-1', turn: 1 };
  }
  async machineSessions(): Promise<MachineSessionLite[]> {
    return [];
  }
  subscribeSession = (): (() => void) => () => undefined;
  openTurn = (): Promise<number | null> => Promise.resolve(null);
  async resume(): Promise<{ sessionId: string; turn: number }> {
    return { sessionId: 'unused', turn: 1 };
  }

  async send(params: { sessionId: string; prompt: string }): Promise<{ turn: number }> {
    this.sendCalls.push(params);
    return { turn: this.sendCalls.length + 1 };
  }

  async transcribe(args: TranscribeArgs): Promise<{ text: string }> {
    this.transcribeCalls.push(args);
    if (this.transcribeError !== undefined) throw this.transcribeError;
    return { text: this.transcribeText };
  }

  async stop(sessionId: string): Promise<boolean> {
    void sessionId;
    return true;
  }
  async rename(): Promise<void> {}

  async list(): Promise<SessionLite[]> {
    return [{ sessionId: 'session-1', status: 'live', cwd: '/tmp/demo' }];
  }

  async watchTurn(params: WatchParams): Promise<TurnResult> {
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-voice-'));
  return {
    store: openTopicStore(path.join(directory, 'telegram.sqlite')),
    directory,
  };
}

function incoming(options: {
  text?: string;
  caption?: string;
  voice?: VoiceAttachment;
  chatId?: number;
  threadId?: number;
  isTopicMessage?: boolean;
  messageId?: number;
}): IncomingMessage {
  return {
    chatId: options.chatId ?? -1001,
    messageId: options.messageId ?? 1,
    from: { id: 42 },
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.caption === undefined ? {} : { caption: options.caption }),
    ...(options.voice === undefined ? {} : { voice: options.voice }),
    isTopicMessage: options.isTopicMessage ?? false,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
  } as IncomingMessage;
}

function update(message: IncomingMessage): TelegramUpdate {
  return { updateId: message.messageId, message };
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

function topicVoice(options: { caption?: string; voice?: VoiceAttachment } = {}): IncomingMessage {
  return incoming({
    caption: options.caption,
    voice: options.voice ?? { fileId: 'voice-file-1', mimeType: 'audio/ogg', fileSize: 1024 },
    threadId: 600,
    isTopicMessage: true,
    messageId: 7,
  });
}

test('topic voice note is transcribed and sent as the turn prompt', async () => {
  const fixture = createFixture();
  const binding = topicBinding();
  fixture.store.bind(binding);
  try {
    await fixture.bot.handleUpdate(update(topicVoice({ caption: 'please do this' })));
    assert.deepEqual(fixture.bridge.transcribeCalls, [
      {
        audio_base64: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64'),
        mime: 'audio/ogg',
      },
    ]);
    assert.deepEqual(fixture.bridge.sendCalls, [
      { sessionId: 'session-1', prompt: 'please do this\nhello from voice' },
    ]);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('topic voice note with an empty transcription replies without sending a turn', async () => {
  const fixture = createFixture();
  const binding = topicBinding();
  fixture.store.bind(binding);
  fixture.bridge.transcribeText = '   ';
  try {
    await fixture.bot.handleUpdate(update(topicVoice()));
    assert.equal(fixture.bridge.sendCalls.length, 0);
    assert.equal(fixture.api.sentMessages.at(-1)?.text, 'nothing was transcribed');
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('topic voice note transcribe failure replies without sending a turn', async () => {
  const fixture = createFixture();
  const binding = topicBinding();
  fixture.store.bind(binding);
  fixture.bridge.transcribeError = new Error('whisper exploded');
  try {
    await fixture.bot.handleUpdate(update(topicVoice()));
    assert.equal(fixture.bridge.sendCalls.length, 0);
    assert.equal(
      fixture.api.sentMessages.at(-1)?.text,
      'voice transcribe failed: whisper exploded',
    );
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('oversize topic voice note is rejected before download without sending a turn', async () => {
  const fixture = createFixture();
  const binding = topicBinding();
  fixture.store.bind(binding);
  try {
    await fixture.bot.handleUpdate(
      update(topicVoice({ voice: { fileId: 'big', fileSize: 16 * 1024 * 1024 } })),
    );
    assert.equal(fixture.bridge.sendCalls.length, 0);
    assert.equal(fixture.bridge.transcribeCalls.length, 0);
    assert.deepEqual(fixture.api.fileCalls, []);
    assert.equal(fixture.api.sentMessages.at(-1)?.text, 'voice note too large (limit 15 MB)');
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('server-side size rejection during download maps to the too-large reply', async () => {
  const fixture = createFixture();
  const binding = topicBinding();
  fixture.store.bind(binding);
  fixture.api.downloadError = new Error('Telegram file exceeds 15 MB limit');
  try {
    await fixture.bot.handleUpdate(update(topicVoice()));
    assert.equal(fixture.bridge.sendCalls.length, 0);
    assert.equal(fixture.api.sentMessages.at(-1)?.text, 'voice note too large (limit 15 MB)');
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('topic photo without text or voice is rejected without sending a turn', async () => {
  const fixture = createFixture();
  const binding = topicBinding();
  fixture.store.bind(binding);
  try {
    await fixture.bot.handleUpdate(
      update(incoming({ threadId: binding.threadId, isTopicMessage: true, messageId: 9 })),
    );
    assert.equal(fixture.bridge.sendCalls.length, 0);
    assert.equal(fixture.bridge.transcribeCalls.length, 0);
    assert.equal(fixture.api.sentMessages.at(-1)?.text, 'I can only read text and voice messages');
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

async function startPendingNew(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await fixture.bot.handleUpdate(update(incoming({ text: '/new' })));
  const callback: CallbackQuery = {
    id: 'callback-1',
    from: { id: 42 },
    data: 'new:demo',
    message: { chatId: -1001, messageId: 2 },
  };
  await fixture.bot.handleUpdate({ updateId: 2, callbackQuery: callback });
}

test('pending first prompt sent as voice resolves into the createSession prompt', async () => {
  const fixture = createFixture();
  try {
    await startPendingNew(fixture);
    await fixture.bot.handleUpdate(
      update(
        incoming({
          voice: { fileId: 'voice-file-9', mimeType: 'audio/ogg' },
          caption: 'build this',
          messageId: 3,
        }),
      ),
    );
    assert.deepEqual(fixture.bridge.openCalls, [
      { cwd: '/tmp/demo', prompt: 'build this\nhello from voice', project: 'demo' },
    ]);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});

test('pending voice note with empty transcription restores pending for a text retry', async () => {
  const fixture = createFixture();
  try {
    await startPendingNew(fixture);
    fixture.bridge.transcribeText = '';
    await fixture.bot.handleUpdate(
      update(
        incoming({ voice: { fileId: 'voice-file-10', mimeType: 'audio/ogg' }, messageId: 4 }),
      ),
    );
    assert.equal(fixture.bridge.openCalls.length, 0);
    assert.equal(
      fixture.api.sentMessages.at(-1)?.text,
      "I couldn't hear anything — please send the first prompt as text or voice again",
    );
    await fixture.bot.handleUpdate(update(incoming({ text: 'retry as text', messageId: 5 })));
    assert.deepEqual(fixture.bridge.openCalls, [
      { cwd: '/tmp/demo', prompt: 'retry as text', project: 'demo' },
    ]);
  } finally {
    cleanup(fixture.store, fixture.directory);
  }
});
