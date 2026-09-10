import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  IncomingMessage,
  SessionBridge,
  TelegramApi,
  TelegramUpdate,
} from '../src/telegram/types.js';
import { resolveMediaPrompt } from '../src/telegram/photo-prompt.js';

type ReplyTarget = { chatId: number; threadId?: number };

class FakeApi implements TelegramApi {
  readonly fileCalls: string[] = [];
  filePath = 'voice/file.ogg';
  fileBytes = new Uint8Array([1, 2, 3, 4]);
  getFileError: unknown;
  downloadError: unknown;

  async getMe(): Promise<{ id: number; username: string }> {
    throw new Error('not implemented');
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }
  async sendMessage(): Promise<{ messageId: number }> {
    throw new Error('not implemented');
  }
  async editMessageText(): Promise<void> {}
  async editMessageReplyMarkup(): Promise<void> {}
  async sendDocument(): Promise<{ messageId: number }> {
    throw new Error('not implemented');
  }
  async createForumTopic(): Promise<{ threadId: number }> {
    throw new Error('not implemented');
  }
  async editForumTopic(): Promise<void> {}
  async answerCallbackQuery(): Promise<void> {}

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
  readonly transcribeCalls: unknown[] = [];
  readonly attachCalls: unknown[] = [];
  transcribeText = 'hello from voice';
  attachPath = '/inbox/session-1/photo.jpg';
  attachError: unknown;

  async health(): Promise<boolean> {
    return true;
  }
  async projects(): Promise<Array<{ name: string; path: string }>> {
    return [];
  }
  async open(): Promise<{ sessionId: string; turn: number }> {
    throw new Error('not implemented');
  }
  async machineSessions(): Promise<never[]> {
    return [];
  }
  subscribeSession = (): (() => void) => () => undefined;
  openTurn = (): Promise<number | null> => Promise.resolve(null);
  async resume(): Promise<{ sessionId: string; turn: number }> {
    throw new Error('not implemented');
  }
  async send(): Promise<{ turn: number }> {
    throw new Error('not implemented');
  }
  async stop(): Promise<boolean> {
    return true;
  }
  async rename(): Promise<void> {}
  async list(): Promise<never[]> {
    return [];
  }
  async watchTurn(): Promise<never> {
    throw new Error('not implemented');
  }

  async transcribe(args: { audio_base64: string; mime?: string }): Promise<{ text: string }> {
    this.transcribeCalls.push(args);
    return { text: this.transcribeText };
  }

  async attachImage(args: {
    session_id: string;
    image_base64: string;
    mime?: string;
    filename?: string;
  }): Promise<{ path: string; size: number }> {
    this.attachCalls.push(args);
    if (this.attachError !== undefined) throw this.attachError;
    return { path: this.attachPath, size: 4 };
  }
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    chatId: -1001,
    messageId: 7,
    from: { id: 42 },
    isTopicMessage: true,
    threadId: 600,
    ...overrides,
  };
}

function fixture(): {
  api: FakeApi;
  bridge: FakeBridge;
  replies: Array<{ target: ReplyTarget; text: string }>;
  reply: (target: ReplyTarget, text: string) => Promise<void>;
} {
  const api = new FakeApi();
  const bridge = new FakeBridge();
  const replies: Array<{ target: ReplyTarget; text: string }> = [];
  const reply = async (target: ReplyTarget, text: string): Promise<void> => {
    replies.push({ target, text });
  };
  return { api, bridge, replies, reply };
}

test('text resolves verbatim without touching voice or photo', async () => {
  const { api, bridge, replies, reply } = fixture();
  const resolved = await resolveMediaPrompt(
    { api, bridge, reply },
    'session-1',
    message({
      text: 'hello there',
    }),
  );
  assert.deepEqual(resolved, { kind: 'prompt', prompt: 'hello there' });
  assert.deepEqual(api.fileCalls, []);
  assert.deepEqual(bridge.transcribeCalls, []);
  assert.deepEqual(bridge.attachCalls, []);
  assert.deepEqual(replies, []);
});

test('voice resolves through transcribe, photo untouched', async () => {
  const { api, bridge, replies, reply } = fixture();
  const resolved = await resolveMediaPrompt(
    { api, bridge, reply },
    'session-1',
    message({
      voice: { fileId: 'voice-1', mimeType: 'audio/ogg', fileSize: 1024 },
      photo: { fileId: 'photo-1', fileSize: 2048, width: 800, height: 600 },
    }),
  );
  assert.deepEqual(resolved, { kind: 'prompt', prompt: 'hello from voice' });
  assert.equal(bridge.transcribeCalls.length, 1);
  assert.deepEqual(bridge.attachCalls, []);
  assert.deepEqual(replies, []);
});

test('photo resolves through attachImage with inbox path', async () => {
  const { api, bridge, replies, reply } = fixture();
  const resolved = await resolveMediaPrompt(
    { api, bridge, reply },
    'session-1',
    message({
      photo: { fileId: 'photo-1', fileSize: 2048, width: 800, height: 600 },
    }),
  );
  assert.deepEqual(resolved, {
    kind: 'prompt',
    prompt: 'photo saved at /inbox/session-1/photo.jpg',
  });
  assert.deepEqual(api.fileCalls, ['getFile:photo-1', 'downloadFile:voice/file.ogg']);
  assert.deepEqual(bridge.transcribeCalls, []);
  assert.deepEqual(bridge.attachCalls, [
    {
      session_id: 'session-1',
      image_base64: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64'),
      mime: 'image/jpeg',
    },
  ]);
  assert.deepEqual(replies, []);
});

test('photo caption joins the inbox path line', async () => {
  const { api, bridge, reply } = fixture();
  const resolved = await resolveMediaPrompt(
    { api, bridge, reply },
    'session-1',
    message({
      photo: { fileId: 'photo-1' },
      caption: 'look at this',
    }),
  );
  assert.deepEqual(resolved, {
    kind: 'prompt',
    prompt: 'photo saved at /inbox/session-1/photo.jpg\nlook at this',
  });
});

test('photo without a session guides instead of attaching', async () => {
  const { api, bridge, replies, reply } = fixture();
  const resolved = await resolveMediaPrompt(
    { api, bridge, reply },
    undefined,
    message({
      photo: { fileId: 'photo-1' },
    }),
  );
  assert.deepEqual(resolved, { kind: 'handled' });
  assert.deepEqual(api.fileCalls, []);
  assert.deepEqual(bridge.attachCalls, []);
  assert.equal(replies.length, 1);
  assert.match(replies[0]?.text ?? '', /start the session with text first/);
});

test('neither text nor voice nor photo is a readable message', async () => {
  const { api, bridge, replies, reply } = fixture();
  const resolved = await resolveMediaPrompt({ api, bridge, reply }, 'session-1', message({}));
  assert.deepEqual(resolved, { kind: 'handled' });
  assert.equal(replies.length, 1);
  assert.match(replies[0]?.text ?? '', /only read text/);
});

test('attach size rejection maps to the too-large reply', async () => {
  const { api, bridge, replies, reply } = fixture();
  bridge.attachError = new Error('Telegram file exceeds 15 MB limit');
  const resolved = await resolveMediaPrompt(
    { api, bridge, reply },
    'session-1',
    message({
      photo: { fileId: 'photo-1' },
    }),
  );
  assert.deepEqual(resolved, { kind: 'handled' });
  assert.match(replies[0]?.text ?? '', /too large/);
});

test('attach failure maps to the attach-failed reply', async () => {
  const { api, bridge, replies, reply } = fixture();
  bridge.attachError = new Error('boom');
  const resolved = await resolveMediaPrompt(
    { api, bridge, reply },
    'session-1',
    message({
      photo: { fileId: 'photo-1' },
    }),
  );
  assert.deepEqual(resolved, { kind: 'handled' });
  assert.match(replies[0]?.text ?? '', /photo attach failed: boom/);
});
