import type { TelegramApi, TelegramConfig, TelegramUpdate } from './types.js';

type JsonRecord = Record<string, unknown>;
type SendMessageParams = Parameters<TelegramApi['sendMessage']>[0];
type EditMessageParams = Parameters<TelegramApi['editMessageText']>[0];
type EditMessageReplyMarkupParams = Parameters<TelegramApi['editMessageReplyMarkup']>[0];
type SendDocumentParams = Parameters<TelegramApi['sendDocument']>[0];
type ForumTopicParams = Parameters<TelegramApi['createForumTopic']>[0];
type EditForumTopicParams = Parameters<TelegramApi['editForumTopic']>[0];

const MAX_TELEGRAM_FILE_BYTES = 15 * 1024 * 1024;

export function createTelegramApi(
  config: TelegramConfig,
  fetchImpl?: typeof fetch,
  apiBaseUrl?: string,
): TelegramApi {
  const configuredBase =
    apiBaseUrl ?? process.env.VIBECODIUM_TELEGRAM_API_BASE ?? 'https://api.telegram.org';
  const baseUrl = configuredBase.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Telegram API base URL is required');

  const requestFetch = fetchImpl ?? globalThis.fetch;
  if (typeof requestFetch !== 'function') throw new Error('fetch implementation is unavailable');
  const apiBase = `${baseUrl}/bot${config.token}`;

  return {
    async getMe(): Promise<{ id: number; username: string }> {
      const value = await postTelegram(requestFetch, `${apiBase}/getMe`, {}, undefined, false);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Telegram API returned an invalid getMe result');
      }
      const result = value as JsonRecord;
      return {
        id: requiredNumber(result.id, 'getMe result.id'),
        username: requiredString(result.username, 'getMe result.username'),
      };
    },

    async getUpdates(
      offset: number,
      timeoutSec: number,
      signal?: AbortSignal,
    ): Promise<TelegramUpdate[]> {
      const value = await postTelegram(
        requestFetch,
        `${apiBase}/getUpdates`,
        { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
        signal,
        false,
      );
      if (!Array.isArray(value)) throw new Error('Telegram getUpdates returned an invalid result');
      return value.map(mapUpdate);
    },

    async sendMessage(params: SendMessageParams): Promise<{ messageId: number }> {
      const body: JsonRecord = { chat_id: params.chatId, text: params.text };
      if (params.threadId !== undefined) body.message_thread_id = params.threadId;
      if (params.markdown) body.parse_mode = 'MarkdownV2';
      if (params.buttons !== undefined) {
        body.reply_markup = {
          inline_keyboard: params.buttons.map((row) =>
            row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
          ),
        };
      }
      const value = await postTelegram(
        requestFetch,
        `${apiBase}/sendMessage`,
        body,
        undefined,
        false,
      );
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Telegram API returned an invalid sendMessage result');
      }
      const result = value as JsonRecord;
      return { messageId: requiredNumber(result.message_id, 'sendMessage result.message_id') };
    },

    async editMessageText(params: EditMessageParams): Promise<void> {
      const body: JsonRecord = {
        chat_id: params.chatId,
        message_id: params.messageId,
        text: params.text,
      };
      if (params.markdown) body.parse_mode = 'MarkdownV2';
      await postTelegram(requestFetch, `${apiBase}/editMessageText`, body, undefined, false);
    },
    async editMessageReplyMarkup(params: EditMessageReplyMarkupParams): Promise<void> {
      const body: JsonRecord = {
        chat_id: params.chatId,
        message_id: params.messageId,
      };
      if (params.buttons !== undefined) {
        body.reply_markup = {
          inline_keyboard: params.buttons.map((row) =>
            row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
          ),
        };
      }
      await postTelegram(requestFetch, `${apiBase}/editMessageReplyMarkup`, body, undefined, false);
    },

    async sendDocument(params: SendDocumentParams): Promise<{ messageId: number }> {
      const form = new FormData();
      form.set('chat_id', String(params.chatId));
      if (params.threadId !== undefined) form.set('message_thread_id', String(params.threadId));
      if (params.caption !== undefined) form.set('caption', params.caption);
      form.set('document', new Blob([params.content], { type: 'text/markdown' }), params.filename);
      const value = await postTelegram(
        requestFetch,
        `${apiBase}/sendDocument`,
        form,
        undefined,
        true,
      );
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Telegram API returned an invalid sendDocument result');
      }
      const result = value as JsonRecord;
      return { messageId: requiredNumber(result.message_id, 'sendDocument result.message_id') };
    },

    async createForumTopic(params: ForumTopicParams): Promise<{ threadId: number }> {
      const value = await postTelegram(
        requestFetch,
        `${apiBase}/createForumTopic`,
        { chat_id: params.chatId, name: params.name },
        undefined,
        false,
      );
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Telegram API returned an invalid createForumTopic result');
      }
      const result = value as JsonRecord;
      return {
        threadId: requiredNumber(
          result.message_thread_id,
          'createForumTopic result.message_thread_id',
        ),
      };
    },
    async editForumTopic(params: EditForumTopicParams): Promise<void> {
      await postTelegram(
        requestFetch,
        `${apiBase}/editForumTopic`,
        { chat_id: params.chatId, message_thread_id: params.threadId, name: params.name },
        undefined,
        false,
      );
    },

    async answerCallbackQuery(id: string, text?: string): Promise<void> {
      const body: JsonRecord = { callback_query_id: id };
      if (text !== undefined) body.text = text;
      await postTelegram(requestFetch, `${apiBase}/answerCallbackQuery`, body, undefined, false);
    },

    async getFile(fileId: string): Promise<{ filePath: string }> {
      const value = await postTelegram(
        requestFetch,
        `${apiBase}/getFile`,
        { file_id: fileId },
        undefined,
        false,
      );
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Telegram file is not ready yet');
      }
      const filePath = (value as JsonRecord).file_path;
      if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new Error('Telegram file is not ready yet');
      }
      return { filePath };
    },

    async downloadFile(filePath: string): Promise<Uint8Array> {
      assertSafeFilePath(filePath);
      const response = await requestFetch(`${baseUrl}/file/bot${config.token}/${filePath}`);
      if (!response.ok) {
        throw new Error(`Telegram file download failed with HTTP ${response.status}`);
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null) {
        const parsed = Number(contentLength);
        if (Number.isFinite(parsed) && parsed > MAX_TELEGRAM_FILE_BYTES) {
          throw new Error('Telegram file exceeds 15 MB limit');
        }
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_TELEGRAM_FILE_BYTES) {
        throw new Error('Telegram file exceeds 15 MB limit');
      }
      return bytes;
    },
  };
}

async function postTelegram<T>(
  requestFetch: typeof fetch,
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  multipart: boolean,
): Promise<T> {
  let retried = false;
  for (;;) {
    const init: RequestInit = { method: 'POST' };
    if (signal !== undefined) init.signal = signal;
    if (multipart) {
      init.body = body as FormData;
    } else {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    const response = await requestFetch(url, init);
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      throw new Error(`Telegram API request failed with HTTP ${response.status}`);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      if (!response.ok) throw new Error(`Telegram API request failed with HTTP ${response.status}`);
      throw new Error('Telegram API returned an invalid response');
    }
    const responseBody = payload as JsonRecord;

    const errorCode = responseBody.error_code;
    const parametersValue = responseBody.parameters;
    let retryAfter: unknown;
    if (
      parametersValue !== null &&
      typeof parametersValue === 'object' &&
      !Array.isArray(parametersValue)
    ) {
      retryAfter = (parametersValue as JsonRecord).retry_after;
    }
    const retryAfterSeconds =
      typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter
        : undefined;
    const shouldRetry =
      !retried && (response.status === 429 || errorCode === 429) && retryAfterSeconds !== undefined;
    if (shouldRetry) {
      retried = true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryAfterSeconds * 1_000);
      });
      continue;
    }

    if (responseBody.ok !== true) {
      const code = typeof errorCode === 'number' ? errorCode : 'unknown';
      const description =
        typeof responseBody.description === 'string' ? responseBody.description : 'unknown error';
      const status = response.ok ? '' : ` (HTTP ${response.status})`;
      throw new Error(`Telegram API error ${code}: ${description}${status}`);
    }
    if (!response.ok) throw new Error(`Telegram API request failed with HTTP ${response.status}`);
    if (!('result' in responseBody)) throw new Error('Telegram API returned an invalid response');
    return responseBody.result as T;
  }
}

function mapUpdate(value: unknown): TelegramUpdate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Telegram API returned an invalid update');
  }
  const update = value as JsonRecord;
  const mapped: TelegramUpdate = {
    updateId: requiredNumber(update.update_id, 'update.update_id'),
  };
  if (update.message !== undefined) mapped.message = mapMessage(update.message);
  if (update.callback_query !== undefined)
    mapped.callbackQuery = mapCallbackQuery(update.callback_query);
  return mapped;
}

function mapMessage(value: unknown): NonNullable<TelegramUpdate['message']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Telegram API returned an invalid update.message');
  }
  const message = value as JsonRecord;
  const chatValue = message.chat;
  const fromValue = message.from;
  if (chatValue === null || typeof chatValue !== 'object' || Array.isArray(chatValue)) {
    throw new Error('Telegram API returned an invalid update.message.chat');
  }
  if (fromValue === null || typeof fromValue !== 'object' || Array.isArray(fromValue)) {
    throw new Error('Telegram API returned an invalid update.message.from');
  }
  const chat = chatValue as JsonRecord;
  const from = fromValue as JsonRecord;
  const mapped: NonNullable<TelegramUpdate['message']> = {
    chatId: requiredNumber(chat.id, 'update.message.chat.id'),
    messageId: requiredNumber(message.message_id, 'update.message.message_id'),
    from: { id: requiredNumber(from.id, 'update.message.from.id') },
    isTopicMessage: message.is_topic_message === true,
  };
  if (typeof message.message_thread_id === 'number') mapped.threadId = message.message_thread_id;
  if (typeof from.username === 'string') mapped.from.username = from.username;
  if (typeof message.text === 'string') mapped.text = message.text;
  if (typeof message.caption === 'string') mapped.caption = message.caption;
  const voiceAttachment =
    mapVoiceAttachment(message.voice, 'audio/ogg') ??
    mapVoiceAttachment(message.audio, 'audio/mpeg') ??
    mapVoiceAttachment(message.video_note, undefined);
  if (voiceAttachment !== undefined) mapped.voice = voiceAttachment;
  const photoAttachment = mapPhotoAttachment(message.photo);
  if (photoAttachment !== undefined) mapped.photo = photoAttachment;
  return mapped;
}

function mapVoiceAttachment(
  value: unknown,
  defaultMimeType: string | undefined,
): NonNullable<TelegramUpdate['message']>['voice'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as JsonRecord;
  if (typeof record.file_id !== 'string' || record.file_id.length === 0) return undefined;
  const attachment: NonNullable<NonNullable<TelegramUpdate['message']>['voice']> = {
    fileId: record.file_id,
  };
  if (typeof record.mime_type === 'string' && record.mime_type.length > 0) {
    attachment.mimeType = record.mime_type;
  } else if (defaultMimeType !== undefined) {
    attachment.mimeType = defaultMimeType;
  }
  if (typeof record.file_size === 'number' && Number.isFinite(record.file_size)) {
    attachment.fileSize = record.file_size;
  }
  return attachment;
}

function mapPhotoAttachment(value: unknown): NonNullable<TelegramUpdate['message']>['photo'] {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  let best: { fileId: string; fileSize?: number; width?: number; height?: number } | undefined;
  let bestScore = -1;
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as JsonRecord;
    if (typeof record.file_id !== 'string' || record.file_id.length === 0) continue;
    const fileSize =
      typeof record.file_size === 'number' && Number.isFinite(record.file_size)
        ? record.file_size
        : undefined;
    const width =
      typeof record.width === 'number' && Number.isFinite(record.width) ? record.width : undefined;
    const height =
      typeof record.height === 'number' && Number.isFinite(record.height)
        ? record.height
        : undefined;
    const score = fileSize ?? (width !== undefined && height !== undefined ? width * height : -1);
    if (best === undefined || score >= bestScore) {
      best = { fileId: record.file_id };
      if (fileSize !== undefined) best.fileSize = fileSize;
      if (width !== undefined) best.width = width;
      if (height !== undefined) best.height = height;
      bestScore = score;
    }
  }
  if (best === undefined) return undefined;
  // Telegram PhotoSize carries no mime type; photos are delivered as JPEG.
  return { ...best, mimeType: 'image/jpeg' };
}

function assertSafeFilePath(filePath: string): void {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Invalid Telegram file path');
  }
  if (filePath.startsWith('/') || filePath.split('/').includes('..')) {
    throw new Error('Invalid Telegram file path');
  }
}

function mapCallbackQuery(value: unknown): NonNullable<TelegramUpdate['callbackQuery']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Telegram API returned an invalid update.callback_query');
  }
  const callback = value as JsonRecord;
  const messageValue = callback.message;
  const fromValue = callback.from;
  if (messageValue === null || typeof messageValue !== 'object' || Array.isArray(messageValue)) {
    throw new Error('Telegram API returned an invalid update.callback_query.message');
  }
  if (fromValue === null || typeof fromValue !== 'object' || Array.isArray(fromValue)) {
    throw new Error('Telegram API returned an invalid update.callback_query.from');
  }
  const message = messageValue as JsonRecord;
  const from = fromValue as JsonRecord;
  const chatValue = message.chat;
  if (chatValue === null || typeof chatValue !== 'object' || Array.isArray(chatValue)) {
    throw new Error('Telegram API returned an invalid update.callback_query.message.chat');
  }
  const chat = chatValue as JsonRecord;
  const mapped: NonNullable<TelegramUpdate['callbackQuery']> = {
    id: requiredString(callback.id, 'update.callback_query.id'),
    from: { id: requiredNumber(from.id, 'update.callback_query.from.id') },
    data: requiredString(callback.data, 'update.callback_query.data'),
    message: {
      chatId: requiredNumber(chat.id, 'update.callback_query.message.chat.id'),
      messageId: requiredNumber(message.message_id, 'update.callback_query.message.message_id'),
    },
  };
  if (typeof message.message_thread_id === 'number') {
    mapped.message.threadId = message.message_thread_id;
  }
  return mapped;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Telegram API returned an invalid ${field}`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Telegram API returned an invalid ${field}`);
  return value;
}
