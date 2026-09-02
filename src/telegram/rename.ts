import type { SessionBridge, TelegramApi, TopicStore } from './types.js';

export const RENAME_GENERAL_REPLY = 'use /rename inside a session topic';

export async function handleRenameCommand(
  {
    api,
    bridge,
    store,
  }: {
    api: Pick<TelegramApi, 'sendMessage' | 'editForumTopic'>;
    bridge: Pick<SessionBridge, 'rename'>;
    store: Pick<TopicStore, 'rename'>;
  },
  {
    chatId,
    threadId,
    sessionId,
    argumentText,
  }: {
    chatId: number;
    threadId: number;
    sessionId: string;
    argumentText: string;
  },
): Promise<void> {
  const name = argumentText.trim();
  if (!name) {
    await api.sendMessage({ chatId, threadId, text: 'usage: /rename <name>' });
    return;
  }

  try {
    await bridge.rename({ sessionId, label: name });
    await api.editForumTopic({ chatId, threadId, name });
    store.rename(threadId, name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api.sendMessage({ chatId, threadId, text: `rename failed: ${message}` });
    return;
  }

  await api.sendMessage({ chatId, threadId, text: `renamed to "${name}"` });
}
