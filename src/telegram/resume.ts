import { basename } from 'node:path';
import type { InlineButton, MachineSessionLite } from './types.js';

export type PendingStart =
  | { kind: 'new'; project: { name: string; path: string } }
  | { kind: 'resume'; source: 'omp' | 'codex'; ref: string; cwd: string; title: string };

export type ResumeSnapshot = MachineSessionLite[];

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

export function buildResumeKeyboard(
  sessions: ResumeSnapshot,
  now: Date = new Date(),
): InlineButton[][] {
  return sessions
    .slice(0, 5)
    .map((session, index) => [
      { text: resumeButtonText(session, now), callbackData: `resume:${index}` },
    ]);
}
