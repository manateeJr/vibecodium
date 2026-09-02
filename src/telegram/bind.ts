import { basename } from 'node:path';
import { formatSessionAge, truncateTitle } from './resume.js';
import type {
  CallbackQuery,
  IncomingMessage,
  InlineButton,
  SessionBridge,
  SessionLite,
  TelegramApi,
  TopicBinding,
  TopicStore,
} from './types.js';

type ReplyTarget = { chatId: number; threadId?: number };

const PAGE_SIZE = 5;
const SNAPSHOT_CAP = 20;

export interface BindSnapshotEntry {
  snapshotId: number;
  sessions: SessionLite[];
  keyboard: 'resume' | 'action';
}

type BindSnapshotRegistry = Map<number, BindSnapshotEntry>;

export type BindCallback =
  | { kind: 'pick'; snapshotId: number; index: number }
  | { kind: 'more'; snapshotId: number; offset: number };

export interface BindHandlerDependencies {
  api: Pick<TelegramApi, 'sendMessage' | 'editMessageReplyMarkup' | 'createForumTopic'>;
  bridge: Pick<SessionBridge, 'list'>;
  store: Pick<TopicStore, 'bind' | 'bySession' | 'all'>;
  ensureHealthy: () => Promise<void>;
  reply: (target: ReplyTarget, text: string) => Promise<void>;
  onBind?: (sessionId: string) => void;
}

export interface BindHandler {
  sendResumeChoices(
    message: IncomingMessage,
    sessions: SessionLite[],
    filter?: string,
  ): Promise<void>;
  clearSnapshot(chatId: number): void;
  handleSessions(message: IncomingMessage): Promise<void>;
  handleCallback(callback: CallbackQuery): Promise<boolean>;
}

function target(message: { chatId: number; threadId?: number }): ReplyTarget {
  if (message.threadId === undefined) return { chatId: message.chatId };
  return { chatId: message.chatId, threadId: message.threadId };
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseBindCallback(data: string): BindCallback | null {
  const parts = data.split(':');
  const [prefix, second, third, fourth] = parts;
  if (prefix !== 'bind' || second === undefined || third === undefined) return null;

  if (parts.length === 3) {
    const snapshotId = parseNonNegativeInteger(second);
    const index = parseNonNegativeInteger(third);
    if (snapshotId === null || snapshotId < 1 || index === null) return null;
    return { kind: 'pick', snapshotId, index };
  }

  if (parts.length === 4 && second === 'more' && fourth !== undefined) {
    const snapshotId = parseNonNegativeInteger(third);
    const offset = parseNonNegativeInteger(fourth);
    if (snapshotId === null || snapshotId < 1 || offset === null) return null;
    return { kind: 'more', snapshotId, offset };
  }
  return null;
}

export function formatBindPickCallback(snapshotId: number, index: number): string {
  return `bind:${snapshotId}:${index}`;
}

export function formatBindMoreCallback(snapshotId: number, offset: number): string {
  return `bind:more:${snapshotId}:${offset}`;
}

export function filterBindableSessions(sessions: SessionLite[], text = ''): SessionLite[] {
  const filter = text.toLowerCase();
  return sessions.filter((session) => {
    const bindable = session.status === 'live' || session.status === 'resumable';
    if (!bindable || !filter) return bindable;
    return [session.label, session.prompt, session.cwd].some((value) =>
      value?.toLowerCase().includes(filter),
    );
  });
}

function promptHead(prompt: string | undefined): string {
  const firstLine = prompt?.trim().split(/\r?\n/, 1)[0]?.trim();
  return firstLine || 'new session';
}

function displayTitle(session: SessionLite, maxLength: number): string {
  return truncateTitle(session.label?.trim() || promptHead(session.prompt), maxLength);
}

function bindButtonText(session: SessionLite, now: Date): string {
  const cwd = session.cwd;
  const updatedAt = session.updatedAt;
  const cwdName = cwd?.trim() ? basename(cwd) : 'unknown';
  const age =
    updatedAt?.trim() && Number.isFinite(Date.parse(updatedAt))
      ? formatSessionAge(updatedAt, now)
      : '—';
  return `● ${displayTitle(session, 40)} · ${cwdName} · ${age}`;
}

export function buildBindKeyboard(
  sessions: SessionLite[],
  snapshotId: number,
  entriesToShow: number,
  now: Date = new Date(),
): InlineButton[][] {
  const available = sessions.slice(0, SNAPSHOT_CAP);
  const visibleCount = Math.min(Math.max(0, Math.floor(entriesToShow)), available.length);
  const keyboard = available.slice(0, visibleCount).map((session, index) => [
    {
      text: bindButtonText(session, now),
      callbackData: formatBindPickCallback(snapshotId, index),
    },
  ]);
  if (visibleCount < available.length) {
    const nextOffset = Math.min(visibleCount + PAGE_SIZE, available.length);
    keyboard.push([
      { text: 'more ›', callbackData: formatBindMoreCallback(snapshotId, nextOffset) },
    ]);
  }
  return keyboard;
}

function buildBindingActionKeyboard(
  sessions: SessionLite[],
  snapshotId: number,
  entriesToShow: number,
): InlineButton[][] {
  const available = sessions.slice(0, SNAPSHOT_CAP);
  const visibleCount = Math.min(Math.max(0, Math.floor(entriesToShow)), available.length);
  const keyboard: InlineButton[][] = [];
  for (const [index] of available.slice(0, visibleCount).entries()) {
    keyboard.push([{ text: 'bind', callbackData: formatBindPickCallback(snapshotId, index) }]);
  }
  if (visibleCount < available.length) {
    const nextOffset = Math.min(visibleCount + PAGE_SIZE, available.length);
    keyboard.push([
      { text: 'more ›', callbackData: formatBindMoreCallback(snapshotId, nextOffset) },
    ]);
  }
  return keyboard;
}

function topicName(session: SessionLite): string {
  return session.label?.trim() || truncateTitle(promptHead(session.prompt), 60);
}

function sessionRow(session: SessionLite, binding: TopicBinding | null): string {
  const bindingState = binding
    ? `bound → ${binding.label} (thread ${binding.threadId})`
    : 'unbound';
  return `${displayTitle(session, 60)} — ${session.status} (${session.sessionId}) · ${bindingState}`;
}

function staleBindingRow(binding: TopicBinding): string {
  return `${binding.label} — unknown (thread ${binding.threadId}, ${binding.sessionId}) · bound → ${binding.label}`;
}

export function createBindHandler(deps: BindHandlerDependencies): BindHandler {
  const { api, bridge, store, ensureHealthy, reply, onBind } = deps;
  const snapshots: BindSnapshotRegistry = new Map();
  let nextSnapshotId = 1;

  function registerSnapshot(
    chatId: number,
    sessions: SessionLite[],
    keyboard: BindSnapshotEntry['keyboard'],
  ): BindSnapshotEntry {
    const entry = {
      snapshotId: nextSnapshotId,
      sessions: sessions.slice(0, SNAPSHOT_CAP).map((session) => ({ ...session })),
      keyboard,
    };
    nextSnapshotId += 1;
    snapshots.set(chatId, entry);
    return entry;
  }

  function clearSnapshot(chatId: number): void {
    snapshots.delete(chatId);
  }

  async function sendResumeChoices(
    message: IncomingMessage,
    sessions: SessionLite[],
    filter?: string,
  ): Promise<void> {
    const filtered = filterBindableSessions(sessions, filter);
    if (filtered.length === 0) {
      clearSnapshot(message.chatId);
      return;
    }
    const entry = registerSnapshot(message.chatId, filtered, 'resume');
    const header = filter
      ? `Live sessions matching "${filter}":`
      : 'Choose a live session to bind, or a machine session to resume:';
    await api.sendMessage({
      chatId: message.chatId,
      text: header,
      buttons: buildBindKeyboard(entry.sessions, entry.snapshotId, PAGE_SIZE),
    });
  }

  async function handleSessions(message: IncomingMessage): Promise<void> {
    await ensureHealthy();
    const sessions = filterBindableSessions(await bridge.list());
    const bindings = store.all();
    const bindingBySession = new Map(bindings.map((binding) => [binding.sessionId, binding]));
    const unbound = sessions.filter((session) => !bindingBySession.has(session.sessionId));
    const entry =
      unbound.length > 0 ? registerSnapshot(message.chatId, unbound, 'action') : undefined;
    if (entry === undefined) clearSnapshot(message.chatId);
    const buttons =
      entry === undefined
        ? undefined
        : buildBindingActionKeyboard(entry.sessions, entry.snapshotId, PAGE_SIZE);
    const liveSessionIds = new Set(sessions.map((session) => session.sessionId));
    const rows = [
      ...sessions.map((session) =>
        sessionRow(session, bindingBySession.get(session.sessionId) ?? null),
      ),
      ...bindings
        .filter((binding) => !liveSessionIds.has(binding.sessionId))
        .map((binding) => staleBindingRow(binding)),
    ];
    if (rows.length === 0) {
      await reply(target(message), '(no live or resumable sessions)');
      return;
    }
    await api.sendMessage({
      chatId: message.chatId,
      text: rows.join('\n'),
      ...(buttons === undefined ? {} : { buttons }),
    });
  }

  async function handleCallback(callback: CallbackQuery): Promise<boolean> {
    if (!callback.data.startsWith('bind:')) return false;
    const parsed = parseBindCallback(callback.data);
    const entry = parsed ? snapshots.get(callback.message.chatId) : undefined;
    if (parsed === null || !entry || entry.snapshotId !== parsed.snapshotId) {
      await reply(target(callback.message), 'that session selection is invalid');
      return true;
    }

    if (parsed.kind === 'more') {
      const offset = Math.min(parsed.offset, entry.sessions.length);
      if (offset < 1) {
        await reply(target(callback.message), 'that session selection is invalid');
        return true;
      }
      await api.editMessageReplyMarkup({
        chatId: callback.message.chatId,
        messageId: callback.message.messageId,
        buttons:
          entry.keyboard === 'action'
            ? buildBindingActionKeyboard(entry.sessions, entry.snapshotId, offset)
            : buildBindKeyboard(entry.sessions, entry.snapshotId, offset),
      });
      return true;
    }

    const session = entry.sessions[parsed.index];
    const bindable = session?.status === 'live' || session?.status === 'resumable';
    if (!session || !bindable) {
      await reply(target(callback.message), 'that session selection is invalid');
      return true;
    }
    snapshots.delete(callback.message.chatId);
    const existing = store.bySession(session.sessionId);
    if (existing) {
      await reply(target(callback.message), `already bound to topic "${existing.label}"`);
      return true;
    }

    const name = topicName(session);
    const topic = await api.createForumTopic({ chatId: callback.message.chatId, name });
    store.bind({
      threadId: topic.threadId,
      sessionId: session.sessionId,
      label: name,
      createdAt: new Date().toISOString(),
    });
    onBind?.(session.sessionId);
    await reply(
      { chatId: callback.message.chatId, threadId: topic.threadId },
      `bound to session ${session.sessionId}`,
    );
    return true;
  }

  return { sendResumeChoices, clearSnapshot, handleSessions, handleCallback };
}
