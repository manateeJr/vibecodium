import type {
  ObservedAsk,
  SessionBridge,
  TelegramApi,
  TelegramConfig,
  TurnProgress,
  TurnResult,
} from './types.js';

type TurnRelayFormat = {
  escapeMarkdownV2(text: string): string;
  chunkText(text: string, max?: number): string[];
};

type TurnRelayParams = {
  chatId: number;
  threadId: number;
  sessionId: string;
  turn: number;
  onAsk?: (ask: ObservedAsk) => void;
};

type TurnRelayDependencies = {
  api: TelegramApi;
  bridge: SessionBridge;
  config: TelegramConfig;
  format: TurnRelayFormat;
};

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1_000));
}

export function createTurnRelay({ api, bridge, config, format }: TurnRelayDependencies): {
  relayTurn(params: TurnRelayParams): Promise<void>;
} {
  async function relayTurn({
    chatId,
    threadId,
    sessionId,
    turn,
    onAsk,
  }: TurnRelayParams): Promise<void> {
    const progressMessage = await api.sendMessage({
      chatId,
      threadId,
      text: 'working… 0s',
    });
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    let progressEdits = Promise.resolve();
    const onProgress = (progress: TurnProgress): void => {
      const now = Date.now();
      if (now - lastProgressAt < config.progressThrottleMs) return;
      lastProgressAt = now;
      progressEdits = progressEdits
        .then(() =>
          api.editMessageText({
            chatId,
            messageId: progressMessage.messageId,
            text: `working… ${Math.floor(progress.elapsedMs / 1_000)}s · ${progress.toolCalls} tool calls`,
          }),
        )
        .catch(() => undefined);
    };
    const result = await bridge.watchTurn({
      sessionId,
      turn,
      timeoutMs: config.turnTimeoutMs,
      onProgress,
      ...(onAsk === undefined ? {} : { onAsk }),
    });
    await progressEdits;
    await renderResult({
      api,
      format,
      chatId,
      threadId,
      turn,
      progressMessageId: progressMessage.messageId,
      result,
    });
  }

  return { relayTurn };
}

async function renderResult({
  api,
  format,
  chatId,
  threadId,
  turn,
  progressMessageId,
  result,
}: {
  api: TelegramApi;
  format: TurnRelayFormat;
  chatId: number;
  threadId: number;
  turn: number;
  progressMessageId: number;
  result: TurnResult;
}): Promise<void> {
  if (result.status === 'timeout') {
    await api.editMessageText({
      chatId,
      messageId: progressMessageId,
      text: `turn timed out after ${seconds(result.elapsedMs)}s; check /status`,
    });
    return;
  }

  const fullText = format.escapeMarkdownV2(result.text);
  const chunks = format.chunkText(fullText);
  const firstChunk = chunks[0] ?? '(no output)';
  await api.editMessageText({
    chatId,
    messageId: progressMessageId,
    text: firstChunk,
    markdown: true,
  });
  if (chunks.length <= 3) {
    for (const chunk of chunks.slice(1)) {
      await api.sendMessage({ chatId, threadId, text: chunk, markdown: true });
    }
    return;
  }
  await api.sendDocument({
    chatId,
    threadId,
    filename: `turn-${turn}.md`,
    content: fullText,
  });
}
