import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type JsonRecord = Record<string, unknown>;
export type WireUpdate = JsonRecord;

export type TelegramCall = {
  endpoint: string;
  body: unknown;
  messageId?: number;
};

export type TelegramStub = {
  calls: TelegramCall[];
  enqueue(update: WireUpdate): void;
  port: number;
  close(): Promise<void>;
  createForumTopic(): number;
};

export type TelegramStubOptions = {
  readonly userId?: number;
  readonly chatId?: number;
  readonly threadId?: number;
};

export const USER_ID = 42;
export const CHAT_ID = -1001;
export const THREAD_ID = 700;

function ids(options: TelegramStubOptions = {}): Required<TelegramStubOptions> {
  return {
    userId: options.userId ?? USER_ID,
    chatId: options.chatId ?? CHAT_ID,
    threadId: options.threadId ?? THREAD_ID,
  };
}

export function readRequest(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.once('error', reject);
    request.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

export function parseBody(contentType: string, bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }
  if (contentType.includes('multipart/form-data')) return parseMultipart(contentType, text);
  return { raw: text };
}

export function parseMultipart(contentType: string, text: string): JsonRecord {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return { raw: text };

  const fields: JsonRecord = {};
  for (const part of text.split(`--${boundary}`)) {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    const name = /name="([^"]+)"/i.exec(headers)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    let value = part.slice(separator + 4);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    fields[name] = filename === undefined ? value : { filename, content: value };
  }
  return fields;
}

export function jsonResponse(response: ServerResponse, status: number, result: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: status >= 200 && status < 300, result }));
}

export function waitForServer(server: Server): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Telegram stub did not expose a TCP address'));
        return;
      }
      resolvePromise((address as AddressInfo).port);
    });
  });
}

export async function startTelegramStub(
  initial: readonly WireUpdate[],
  options: TelegramStubOptions = {},
): Promise<TelegramStub> {
  const configured = ids(options);
  const queue = [...initial];
  const calls: TelegramCall[] = [];
  let nextMessageId = 900;
  const server = createServer(async (request, response) => {
    const endpoint =
      new URL(request.url ?? '/', 'http://127.0.0.1').pathname.split('/').at(-1) ?? '';
    const body = parseBody(
      String(request.headers['content-type'] ?? ''),
      await readRequest(request),
    );
    const call: TelegramCall = { endpoint, body };
    calls.push(call);

    if (endpoint === 'getMe') {
      jsonResponse(response, 200, { id: 99, is_bot: true, username: 'e2e_bot' });
      return;
    }
    if (endpoint === 'getUpdates') {
      // A short real wait models an empty long poll while keeping this live test bounded.
      const update = queue.shift();
      if (update === undefined)
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      jsonResponse(response, 200, update === undefined ? [] : [update]);
      return;
    }
    if (endpoint === 'sendMessage' || endpoint === 'sendDocument') {
      nextMessageId += 1;
      call.messageId = nextMessageId;
      jsonResponse(response, 200, { message_id: nextMessageId });
      return;
    }
    if (
      endpoint === 'editMessageText' ||
      endpoint === 'editMessageReplyMarkup' ||
      endpoint === 'editForumTopic' ||
      endpoint === 'answerCallbackQuery'
    ) {
      jsonResponse(response, 200, true);
      return;
    }
    if (endpoint === 'createForumTopic') {
      jsonResponse(response, 200, { message_thread_id: configured.threadId });
      return;
    }
    jsonResponse(response, 404, undefined);
  });
  const port = await waitForServer(server);
  return {
    calls,
    enqueue(update: WireUpdate): void {
      queue.push(update);
    },
    port,
    close: async (): Promise<void> => {
      if (!server.listening) return;
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
    createForumTopic(): number {
      return configured.threadId;
    },
  };
}

export function messageUpdate(
  updateId: number,
  messageId: number,
  text: string,
  topic: boolean,
  options: TelegramStubOptions = {},
): WireUpdate {
  const configured = ids(options);
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: configured.userId, username: 'owner' },
      chat: { id: configured.chatId, type: 'supergroup' },
      ...(topic
        ? { message_thread_id: configured.threadId, is_topic_message: true }
        : { is_topic_message: false }),
      text,
    },
  };
}

export function callBody(call: TelegramCall): JsonRecord {
  if (typeof call.body !== 'object' || call.body === null) {
    throw new Error(`Telegram ${call.endpoint} body is not an object`);
  }
  return call.body as JsonRecord;
}
