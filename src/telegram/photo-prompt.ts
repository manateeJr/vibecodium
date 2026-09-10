import type { IncomingMessage, SessionBridge, TelegramApi } from './types.js';
import { resolvePrompt } from './voice-prompt.js';

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

export type ResolvedPhotoPrompt =
  { kind: 'prompt'; prompt: string } | { kind: 'empty' } | { kind: 'handled' };

export interface PhotoResolverDeps {
  api: TelegramApi;
  bridge: SessionBridge;
  reply: (target: { chatId: number; threadId?: number }, text: string) => Promise<void>;
}

function messageTarget(message: IncomingMessage): { chatId: number; threadId?: number } {
  if (message.threadId === undefined) return { chatId: message.chatId };
  return { chatId: message.chatId, threadId: message.threadId };
}

export async function resolvePhoto(
  deps: PhotoResolverDeps,
  sessionId: string,
  message: IncomingMessage,
): Promise<ResolvedPhotoPrompt> {
  const { api, bridge, reply } = deps;
  const text = message.text;
  if (text !== undefined && text.trim() !== '') return { kind: 'prompt', prompt: text };
  const photo = message.photo;
  if (photo === undefined) {
    // Wording matches voice-prompt until L0 rewires bot.ts at integration.
    await reply(messageTarget(message), 'I can only read text and voice messages');
    return { kind: 'handled' };
  }
  if (photo.fileSize !== undefined && photo.fileSize > MAX_PHOTO_BYTES) {
    await reply(messageTarget(message), 'photo too large (limit 15 MB)');
    return { kind: 'handled' };
  }
  try {
    const file = await api.getFile(photo.fileId);
    const bytes = await api.downloadFile(file.filePath);
    const attached = await bridge.attachImage({
      session_id: sessionId,
      image_base64: Buffer.from(bytes).toString('base64'),
      mime: photo.mimeType ?? 'image/jpeg',
    });
    const combined = [`photo saved at ${attached.path}`, message.caption?.trim() ?? '']
      .filter((part) => part !== '')
      .join('\n');
    if (combined === '') return { kind: 'empty' };
    return { kind: 'prompt', prompt: combined };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/exceeds 15 MB limit/i.test(reason)) {
      await reply(messageTarget(message), 'photo too large (limit 15 MB)');
    } else {
      await reply(messageTarget(message), `photo attach failed: ${reason}`);
    }
    return { kind: 'handled' };
  }
}

export async function resolveMediaPrompt(
  deps: PhotoResolverDeps,
  sessionId: string | undefined,
  message: IncomingMessage,
): Promise<ResolvedPhotoPrompt> {
  const photoFirst =
    message.photo !== undefined &&
    (message.text?.trim() ?? '') === '' &&
    message.voice === undefined;
  if (!photoFirst) return resolvePrompt(deps, message);
  if (sessionId === undefined) {
    await deps.reply(
      messageTarget(message),
      'start the session with text first, then send photos in the thread',
    );
    return { kind: 'handled' };
  }
  const photo = await resolvePhoto(deps, sessionId, message);
  if (photo.kind === 'empty') {
    await deps.reply(messageTarget(message), 'could not use that photo');
    return { kind: 'handled' };
  }
  return photo;
}
