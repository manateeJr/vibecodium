import type {
  CallbackQuery,
  InlineButton,
  SessionBridge,
  TelegramApi,
  TopicStore,
} from './types.js';

// Telegram rendering + callback seam for native omp `ask` (issue #116).
// The control plane emits `action_requested` with an omp-ask payload (Lane A owns
// events.ts); the bridge lane surfaces it as subscribeAsk/answerAsk. This module
// owns the topic UX only: post questions with an inline keyboard, translate taps
// into answerAsk calls, and edit the message into a terminal state exactly once.

export interface AskOptionWire {
  readonly label: string;
  readonly description?: string;
}

export interface AskQuestionWire {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly AskOptionWire[];
}

export interface AskRequestedWire {
  readonly session_id: string;
  readonly turn: number;
  readonly ask_id: string;
  readonly questions: readonly AskQuestionWire[];
  readonly source: string;
  readonly requested_at: string;
}

export interface AskOption {
  readonly label: string;
  readonly description?: string;
}

export interface AskQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly AskOption[];
}

export interface AskRequest {
  readonly sessionId: string;
  readonly turn: number;
  readonly askId: string;
  readonly questions: readonly AskQuestion[];
  readonly source: string;
  readonly requestedAt: string;
}

export interface AskAnswer {
  readonly session_id: string;
  readonly ask_id: string;
  readonly question_id: string;
  readonly option_index: number;
}

export interface AskAnswerOutcome {
  readonly status?: string;
}

export interface AskRelayBridge {
  readonly subscribeAsk?: (onAsk: (request: AskRequestedWire) => void) => () => void;
  readonly answerAsk?: (answer: AskAnswer) => Promise<AskAnswerOutcome | void>;
}

export interface AskRelayFormat {
  escapeMarkdownV2(text: string): string;
}

export interface AskRelayDependencies {
  readonly api: TelegramApi;
  readonly bridge: SessionBridge & AskRelayBridge;
  readonly store: TopicStore;
  readonly chatId: number;
  readonly format: AskRelayFormat;
  readonly timeoutMs?: number;
}

export interface AskRelay {
  start(): void;
  stop(): void;
  renderAsk(request: AskRequest): Promise<void>;
  handleCallback(query: CallbackQuery): Promise<boolean>;
  markDenied(askId: string): Promise<void>;
  markTimedOut(askId: string): Promise<void>;
}

export const ASK_CALLBACK_PREFIX = 'ask:';
const ASK_TRACK_LIMIT = 64;
const BUTTON_LABEL_LIMIT = 48;
const ACK_TEXT_LIMIT = 180;

type AskEntryState = 'open' | 'answering' | 'answered' | 'denied' | 'timed-out';

interface AskEntry {
  request: AskRequest;
  chatId: number;
  messageId: number;
  state: AskEntryState;
  editDone: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function normalizeAskRequest(wire: AskRequestedWire): AskRequest {
  const questions = Array.isArray(wire.questions) ? wire.questions : [];
  return {
    sessionId: wire.session_id,
    turn: wire.turn,
    askId: wire.ask_id,
    questions: questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: (Array.isArray(question.options) ? question.options : []).map(
        (option: AskOptionWire) => ({
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        }),
      ),
    })),
    source: wire.source,
    requestedAt: wire.requested_at,
  };
}

export function formatAskCallback(
  askId: string,
  questionIndex: number,
  optionIndex: number,
): string {
  return `${ASK_CALLBACK_PREFIX}${encodeURIComponent(askId)}:${questionIndex}:${optionIndex}`;
}

export function parseAskCallback(
  data: string,
): { askId: string; questionIndex: number; optionIndex: number } | null {
  if (!data.startsWith(ASK_CALLBACK_PREFIX)) return null;
  const parts = data.slice(ASK_CALLBACK_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const [encoded, questionRaw, optionRaw] = parts;
  if (encoded === undefined || questionRaw === undefined || optionRaw === undefined) return null;
  let askId: string;
  try {
    askId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!askId || !/^\d+$/.test(questionRaw) || !/^\d+$/.test(optionRaw)) return null;
  return { askId, questionIndex: Number(questionRaw), optionIndex: Number(optionRaw) };
}

export function buildAskText(request: AskRequest, escape: (text: string) => string): string {
  const lines = ['❓ input needed'];
  request.questions.forEach((question, questionIndex) => {
    const prefix = request.questions.length > 1 ? `Q${questionIndex + 1} ` : '';
    lines.push('', `*${escape(`${prefix}${question.header}`)}*`, escape(question.question));
    question.options.forEach((option, optionIndex) => {
      const description = option.description === undefined ? '' : ` — ${option.description}`;
      lines.push(`${optionIndex + 1}\\. ${escape(option.label)}${escape(description)}`);
    });
  });
  return lines.join('\n');
}

export function buildAskKeyboard(request: AskRequest): InlineButton[][] {
  const multi = request.questions.length > 1;
  return request.questions.flatMap((question, questionIndex) =>
    question.options.map((option, optionIndex) => [
      {
        text: buttonLabel(multi ? questionIndex : undefined, option.label),
        callbackData: formatAskCallback(request.askId, questionIndex, optionIndex),
      },
    ]),
  );
}

export function buildAnsweredText(
  question: AskQuestion,
  option: AskOption,
  escape: (text: string) => string,
): string {
  return `✅ answered\n*${escape(question.header)}*\n${escape(option.label)}`;
}

export function buildDeniedText(question: AskQuestion, escape: (text: string) => string): string {
  return `🚫 declined\n*${escape(question.header)}*`;
}

export function buildTimedOutText(escape: (text: string) => string): string {
  return escape('⌛ question expired without an answer');
}

function buttonLabel(questionIndex: number | undefined, label: string): string {
  const prefix = questionIndex === undefined ? '' : `Q${questionIndex + 1}: `;
  const text = `${prefix}${label}`;
  return text.length <= BUTTON_LABEL_LIMIT ? text : `${text.slice(0, BUTTON_LABEL_LIMIT - 1)}…`;
}
function ackText(label: string): string {
  const text = `recorded: ${label}`;
  return text.length <= ACK_TEXT_LIMIT ? text : `${text.slice(0, ACK_TEXT_LIMIT - 1)}…`;
}

export function createAskRelay({
  api,
  bridge,
  store,
  chatId,
  format,
  timeoutMs = 0,
}: AskRelayDependencies): AskRelay {
  const tracked = new Map<string, AskEntry>();
  const pendingAsks = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let started = false;

  const escape = (text: string): string => format.escapeMarkdownV2(text);

  function remember(entry: AskEntry): void {
    tracked.set(entry.request.askId, entry);
    while (tracked.size > ASK_TRACK_LIMIT) {
      const oldest = tracked.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const removed = tracked.get(oldest);
      if (removed?.timer !== undefined) clearTimeout(removed.timer);
      tracked.delete(oldest);
    }
  }

  function clearTimer(entry: AskEntry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  async function renderTerminal(entry: AskEntry, text: string): Promise<void> {
    if (entry.editDone) return;
    entry.editDone = true;
    await api.editMessageText({
      chatId: entry.chatId,
      messageId: entry.messageId,
      text,
      markdown: true,
    });
    await api.editMessageReplyMarkup({
      chatId: entry.chatId,
      messageId: entry.messageId,
      buttons: [],
    });
  }

  async function renderAsk(request: AskRequest): Promise<void> {
    // Synchronous guard: concurrent deliveries (subscribe replay + turn hook)
    // must collapse into one post before the first await yields.
    if (tracked.has(request.askId) || pendingAsks.has(request.askId)) return;
    pendingAsks.add(request.askId);
    try {
      const binding = store.bySession(request.sessionId);
      if (binding === null) return;
      // The bridge replays history at-least-once on subscribe: only the ask whose
      // turn is still open is live. Fail open so a transient read never drops one.
      try {
        if ((await bridge.openTurn(request.sessionId)) !== request.turn) return;
      } catch {
        // Fall through and render.
      }
      const buttons = buildAskKeyboard(request);
      const sent = await api.sendMessage({
        chatId,
        threadId: binding.threadId,
        text: buildAskText(request, escape),
        markdown: true,
        ...(buttons.length === 0 ? {} : { buttons }),
      });
      const entry: AskEntry = {
        request,
        chatId,
        messageId: sent.messageId,
        state: 'open',
        editDone: false,
        timer: undefined,
      };
      remember(entry);
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          void markTimedOut(request.askId).catch(() => undefined);
        }, timeoutMs);
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
      }
    } finally {
      pendingAsks.delete(request.askId);
    }
  }

  async function markDenied(askId: string): Promise<void> {
    const entry = tracked.get(askId);
    if (entry === undefined || entry.editDone) return;
    clearTimer(entry);
    entry.state = 'denied';
    const question = entry.request.questions[0];
    await renderTerminal(
      entry,
      question === undefined ? escape('🚫 declined') : buildDeniedText(question, escape),
    );
  }

  async function markTimedOut(askId: string): Promise<void> {
    const entry = tracked.get(askId);
    if (entry === undefined || entry.editDone) return;
    clearTimer(entry);
    entry.state = 'timed-out';
    await renderTerminal(entry, buildTimedOutText(escape));
  }

  async function handleCallback(query: CallbackQuery): Promise<boolean> {
    const parsed = parseAskCallback(query.data);
    if (parsed === null) return false;
    const entry = tracked.get(parsed.askId);
    if (entry === undefined) {
      await api.answerCallbackQuery(query.id, 'that question is no longer pending');
      return true;
    }
    if (entry.state !== 'open') {
      await api.answerCallbackQuery(query.id, 'already recorded');
      return true;
    }
    const question = entry.request.questions[parsed.questionIndex];
    const option = question?.options[parsed.optionIndex];
    if (question === undefined || option === undefined) {
      await api.answerCallbackQuery(query.id, 'that option is no longer available');
      return true;
    }
    if (bridge.answerAsk === undefined) {
      await api.answerCallbackQuery(query.id, 'answering is unavailable');
      return true;
    }
    entry.state = 'answering';
    let outcome: AskAnswerOutcome | void;
    try {
      outcome = await bridge.answerAsk({
        session_id: entry.request.sessionId,
        ask_id: entry.request.askId,
        question_id: question.id,
        option_index: parsed.optionIndex,
      });
    } catch {
      entry.state = 'open';
      await api.answerCallbackQuery(query.id, 'could not record the answer; try again');
      return true;
    }
    if (entry.editDone) {
      await api.answerCallbackQuery(query.id, ackText(option.label));
      return true;
    }
    const denied =
      typeof outcome === 'object' &&
      outcome !== null &&
      (outcome as { status?: unknown }).status === 'denied';
    entry.state = denied ? 'denied' : 'answered';
    clearTimer(entry);
    await api.answerCallbackQuery(query.id, ackText(option.label));
    if (denied) {
      await renderTerminal(entry, buildDeniedText(question, escape));
    } else {
      await renderTerminal(entry, buildAnsweredText(question, option, escape));
    }
    return true;
  }

  function start(): void {
    if (started) return;
    started = true;
    if (bridge.subscribeAsk === undefined) return;
    unsubscribe = bridge.subscribeAsk((wire) => {
      void renderAsk(normalizeAskRequest(wire)).catch(() => undefined);
    });
  }

  function stop(): void {
    started = false;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const entry of tracked.values()) clearTimer(entry);
    tracked.clear();
  }

  return { start, stop, renderAsk, handleCallback, markDenied, markTimedOut };
}
