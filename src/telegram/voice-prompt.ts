import type { IncomingMessage, SessionBridge, TelegramApi } from './types.js';

export const MAX_VOICE_BYTES = 15 * 1024 * 1024;

export type ResolvedPrompt =
  | { kind: 'prompt'; prompt: string }
  | { kind: 'empty' }
  | { kind: 'handled' };

export interface PromptResolverDeps {
  api: TelegramApi;
  bridge: SessionBridge;
  reply: (target: { chatId: number; threadId?: number }, text: string) => Promise<void>;
}

function messageTarget(message: IncomingMessage): { chatId: number; threadId?: number } {
  if (message.threadId === undefined) return { chatId: message.chatId };
  return { chatId: message.chatId, threadId: message.threadId };
}

export async function resolvePrompt(
  deps: PromptResolverDeps,
  message: IncomingMessage,
): Promise<ResolvedPrompt> {
  const { api, bridge, reply } = deps;
  const text = message.text;
  if (text !== undefined && text.trim() !== '') return { kind: 'prompt', prompt: text };
  const voice = message.voice;
  if (voice === undefined) {
    await reply(messageTarget(message), 'I can only read text and voice messages');
    return { kind: 'handled' };
  }
  if (voice.fileSize !== undefined && voice.fileSize > MAX_VOICE_BYTES) {
    await reply(messageTarget(message), 'voice note too large (limit 15 MB)');
    return { kind: 'handled' };
  }
  try {
    const file = await api.getFile(voice.fileId);
    const bytes = await api.downloadFile(file.filePath);
    const transcribed = await bridge.transcribe({
      audio_base64: Buffer.from(bytes).toString('base64'),
      mime: voice.mimeType ?? 'audio/ogg',
    });
    const transcript = transcribed.text;
    const combined = [message.caption?.trim() ?? '', transcript.trim()]
      .filter((part) => part !== '')
      .join('\n');
    if (combined === '') return { kind: 'empty' };
    return { kind: 'prompt', prompt: combined };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/exceeds 15 MB limit/i.test(reason)) {
      await reply(messageTarget(message), 'voice note too large (limit 15 MB)');
    } else {
      await reply(messageTarget(message), `voice transcribe failed: ${reason}`);
    }
    return { kind: 'handled' };
  }
}
