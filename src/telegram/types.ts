// Pinned shared contract for the Telegram frontend (issue #106).
// Implemented by the api, bridge, and bot lanes.

export interface TelegramConfig {
  token: string;
  allowedUserId: number;
  chatId: number; // the forum supergroup
  controlPlaneUrl: string;
  dbPath: string;
  pollTimeoutSec: number;
  progressThrottleMs: number;
  turnTimeoutMs: number;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface IncomingMessage {
  chatId: number;
  threadId?: number;
  messageId: number;
  from: { id: number; username?: string };
  text?: string;
  isTopicMessage: boolean;
}

export interface CallbackQuery {
  id: string;
  from: { id: number };
  data: string;
  message: { chatId: number; messageId: number; threadId?: number };
}

export interface TelegramUpdate {
  updateId: number;
  message?: IncomingMessage;
  callbackQuery?: CallbackQuery;
}

export interface TelegramApi {
  getMe(): Promise<{ id: number; username: string }>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(p: {
    chatId: number;
    threadId?: number;
    text: string;
    markdown?: boolean;
    buttons?: InlineButton[][];
  }): Promise<{ messageId: number }>;
  editMessageText(p: {
    chatId: number;
    messageId: number;
    text: string;
    markdown?: boolean;
  }): Promise<void>;
  editMessageReplyMarkup(p: {
    chatId: number;
    messageId: number;
    buttons?: InlineButton[][];
  }): Promise<void>;
  sendDocument(p: {
    chatId: number;
    threadId?: number;
    filename: string;
    content: string;
    caption?: string;
  }): Promise<{ messageId: number }>;
  createForumTopic(p: { chatId: number; name: string }): Promise<{
    threadId: number;
  }>;
  editForumTopic(p: { chatId: number; threadId: number; name: string }): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
}

export interface TurnProgress {
  elapsedMs: number;
  toolCalls: number;
}

export interface TurnResult {
  status: 'complete' | 'failed' | 'timeout';
  text: string;
  elapsedMs: number;
  toolCalls: number;
}

export interface SessionLite {
  sessionId: string;
  status: string;
  label?: string;
  cwd?: string;
}
export interface MachineSessionLite {
  source: 'omp' | 'codex';
  ref: string;
  title: string;
  cwd: string;
  updatedAt: string;
}

export interface SessionBridge {
  health(): Promise<boolean>;
  projects(): Promise<Array<{ name: string; path: string }>>;
  open(p: {
    cwd: string;
    prompt: string;
    project?: string;
  }): Promise<{ sessionId: string; turn: number }>;
  machineSessions(): Promise<MachineSessionLite[]>;
  resume(p: {
    source: 'omp' | 'codex';
    ref: string;
    prompt: string;
    cwd?: string;
  }): Promise<{ sessionId: string; turn: number }>;
  send(p: { sessionId: string; prompt: string }): Promise<{ turn: number }>;
  stop(sessionId: string): Promise<boolean>;
  rename(p: { sessionId: string; label: string }): Promise<void>;
  list(): Promise<SessionLite[]>;
  watchTurn(p: {
    sessionId: string;
    turn: number;
    onProgress: (progress: TurnProgress) => void;
    timeoutMs: number;
  }): Promise<TurnResult>;
}

export interface TopicBinding {
  threadId: number;
  sessionId: string;
  label: string;
  createdAt: string;
}

export interface TopicStore {
  bind(binding: TopicBinding): void;
  byThread(threadId: number): TopicBinding | null;
  all(): TopicBinding[];
  unbind(threadId: number): void;
  rename(threadId: number, label: string): void;
  getOffset(): number;
  setOffset(offset: number): void; // persisted getUpdates offset
  close(): void;
}
