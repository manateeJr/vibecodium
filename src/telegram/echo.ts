import type { ObservedTurn, TelegramApi, TopicStore } from './types.js';

const TELEGRAM_MESSAGE_LIMIT = 4_096;

type EchoFormat = {
  escapeMarkdownV2(text: string): string;
  chunkText(text: string, max?: number): string[];
};

type EchoDependencies = {
  api: TelegramApi;
  store: TopicStore;
  format: EchoFormat;
  chatId: number;
};

export function createEcho({ api, store, format, chatId }: EchoDependencies): {
  echoTurn(turn: ObservedTurn): Promise<void>;
} {
  const echoTurn = async (turn: ObservedTurn): Promise<void> => {
    const binding = store.bySession(turn.sessionId);
    if (binding === null) return;

    const prefix = '▶ ';
    const escapedPrompt = format.escapeMarkdownV2(turn.prompt);
    let header = `${prefix}${escapedPrompt}`;
    if (header.length > TELEGRAM_MESSAGE_LIMIT) {
      const maxPromptLength = TELEGRAM_MESSAGE_LIMIT - prefix.length - 1;
      let truncatedPrompt = '';
      for (const character of turn.prompt) {
        const escapedCharacter = format.escapeMarkdownV2(character);
        if (truncatedPrompt.length + escapedCharacter.length > maxPromptLength) break;
        truncatedPrompt += escapedCharacter;
      }
      header = `${prefix}${truncatedPrompt}…`;
    }
    await api.sendMessage({
      chatId,
      threadId: binding.threadId,
      text: header,
      markdown: true,
    });

    const fullText = format.escapeMarkdownV2(turn.text);
    const chunks = format.chunkText(fullText);
    if (chunks.length <= 3) {
      const outputChunks = chunks.length === 0 ? ['(no output)'] : chunks;
      for (const chunk of outputChunks) {
        await api.sendMessage({
          chatId,
          threadId: binding.threadId,
          text: chunk,
          markdown: true,
        });
      }
      return;
    }
    await api.sendDocument({
      chatId,
      threadId: binding.threadId,
      filename: `turn-${turn.turn}.md`,
      content: fullText,
    });
  };

  return { echoTurn };
}
