import { basename } from 'node:path';
import type {
  CallbackQuery,
  IncomingMessage,
  InlineButton,
  MachineSessionLite,
  SessionBridge,
  TelegramApi,
} from './types.js';

const PAGE_SIZE = 5;
const SNAPSHOT_CAP = 20;

export type PendingStart =
  | { kind: 'new'; project: { name: string; path: string } }
  | { kind: 'resume'; source: 'omp' | 'codex'; ref: string; cwd: string; title: string };

export type ResumeSnapshot = MachineSessionLite[];

export interface ResumeSnapshotEntry {
  snapshotId: number;
  sessions: ResumeSnapshot;
}

export type ResumeSnapshotRegistry = Map<number, ResumeSnapshotEntry>;

export type ResumeCallback =
  | { kind: 'pick'; snapshotId: number; index: number }
  | { kind: 'more'; snapshotId: number; offset: number };

export type ResumeReplyTarget = { chatId: number; threadId?: number };

export interface ResumeHandlerDependencies {
  api: Pick<TelegramApi, 'sendMessage' | 'editMessageReplyMarkup'>;
  bridge: Pick<SessionBridge, 'machineSessions'>;
  ensureHealthy: () => Promise<void>;
  pendingStarts: Map<number, PendingStart>;
  reply: (target: ResumeReplyTarget, text: string) => Promise<void>;
}

export interface ResumeHandler {
  handleCommand(message: IncomingMessage): Promise<void>;
  handleCallback(callback: CallbackQuery): Promise<boolean>;
}

export function truncateTitle(title: string, maxLength: number): string {
  return title.slice(0, maxLength);
}

export function formatSessionAge(updatedAt: string, now: Date): string {
  const updatedTime = Date.parse(updatedAt);
  const elapsedMs = Number.isFinite(updatedTime)
    ? Math.max(0, now.getTime() - updatedTime)
    : Number.POSITIVE_INFINITY;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function resumeButtonText(session: MachineSessionLite, now: Date): string {
  return `${truncateTitle(session.title, 40)} · ${basename(session.cwd)} · ${formatSessionAge(session.updatedAt, now)}`;
}

export function formatResumePickCallback(snapshotId: number, index: number): string {
  return `resume:${snapshotId}:${index}`;
}

export function formatResumeMoreCallback(snapshotId: number, offset: number): string {
  return `resume:more:${snapshotId}:${offset}`;
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseResumeCallback(data: string): ResumeCallback | null {
  const parts = data.split(':');
  const [prefix, second, third, fourth] = parts;
  if (prefix !== 'resume' || second === undefined || third === undefined) return null;

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

export function matchesResumeFilter(session: MachineSessionLite, text: string): boolean {
  const filter = text.toLowerCase();
  return session.title.toLowerCase().includes(filter) || session.cwd.toLowerCase().includes(filter);
}

export function buildResumeKeyboard(
  sessions: ResumeSnapshot,
  snapshotId: number,
  entriesToShow: number,
  now: Date = new Date(),
): InlineButton[][] {
  const available = sessions.slice(0, SNAPSHOT_CAP);
  const visibleCount = Math.min(Math.max(0, Math.floor(entriesToShow)), available.length);
  const keyboard = available.slice(0, visibleCount).map((session, index) => [
    {
      text: resumeButtonText(session, now),
      callbackData: formatResumePickCallback(snapshotId, index),
    },
  ]);
  if (visibleCount < available.length) {
    const nextOffset = Math.min(visibleCount + PAGE_SIZE, available.length);
    keyboard.push([
      { text: 'more ›', callbackData: formatResumeMoreCallback(snapshotId, nextOffset) },
    ]);
  }
  return keyboard;
}

function commandArguments(text: string): string {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? '' : trimmed.slice(firstSpace).trim();
}

function target(message: { chatId: number; threadId?: number }): ResumeReplyTarget {
  if (message.threadId === undefined) return { chatId: message.chatId };
  return { chatId: message.chatId, threadId: message.threadId };
}

function copySnapshot(sessions: MachineSessionLite[]): ResumeSnapshot {
  return sessions.slice(0, SNAPSHOT_CAP).map((session) => ({ ...session }));
}

export function createResumeHandler(deps: ResumeHandlerDependencies): ResumeHandler {
  const { api, bridge, ensureHealthy, pendingStarts, reply } = deps;
  const snapshots: ResumeSnapshotRegistry = new Map();
  let nextSnapshotId = 1;

  function registerSnapshot(chatId: number, sessions: ResumeSnapshot): ResumeSnapshotEntry {
    const entry = { snapshotId: nextSnapshotId, sessions };
    nextSnapshotId += 1;
    snapshots.set(chatId, entry);
    return entry;
  }

  function setPendingResume(chatId: number, session: MachineSessionLite): void {
    pendingStarts.set(chatId, {
      kind: 'resume',
      source: session.source,
      ref: session.ref,
      cwd: session.cwd,
      title: session.title,
    });
  }

  async function sendChoices(
    message: IncomingMessage,
    header: string,
    sessions: MachineSessionLite[],
    emptyText: string,
  ): Promise<void> {
    const snapshot = copySnapshot(sessions);
    if (snapshot.length === 0) {
      snapshots.delete(message.chatId);
      await reply(target(message), emptyText);
      return;
    }

    const entry = registerSnapshot(message.chatId, snapshot);
    await api.sendMessage({
      chatId: message.chatId,
      text: header,
      buttons: buildResumeKeyboard(entry.sessions, entry.snapshotId, PAGE_SIZE),
    });
  }

  async function handleCommand(message: IncomingMessage): Promise<void> {
    const args = commandArguments(message.text ?? '');
    await ensureHealthy();
    const sessions = await bridge.machineSessions();
    if (!args) {
      await sendChoices(
        message,
        'Choose a machine session, then send the first prompt here:',
        sessions,
        'no machine sessions found',
      );
      return;
    }

    const exact = sessions.find((session) => session.ref === args);
    if (exact) {
      snapshots.delete(message.chatId);
      setPendingResume(message.chatId, exact);
      await reply(target(message), `send the first prompt to continue "${exact.title}"`);
      return;
    }

    const matching = sessions.filter((session) => matchesResumeFilter(session, args));
    await sendChoices(
      message,
      `Sessions matching "${args}":`,
      matching,
      `no machine sessions match "${args}"`,
    );
  }

  async function handleCallback(callback: CallbackQuery): Promise<boolean> {
    if (!callback.data.startsWith('resume:')) return false;
    const parsed = parseResumeCallback(callback.data);
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
        buttons: buildResumeKeyboard(entry.sessions, entry.snapshotId, offset),
      });
      return true;
    }

    const session = entry.sessions[parsed.index];
    if (!session) {
      await reply(target(callback.message), 'that session selection is invalid');
      return true;
    }
    snapshots.delete(callback.message.chatId);
    setPendingResume(callback.message.chatId, session);
    await reply(target(callback.message), `send the first prompt to continue "${session.title}"`);
    return true;
  }

  return { handleCommand, handleCallback };
}
