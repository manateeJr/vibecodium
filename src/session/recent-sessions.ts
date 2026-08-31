import type { EventEnvelope } from '../contracts/events.js';
import type { SessionSummary } from '../contracts/session-commands.js';
import {
  RECENT_PREVIEW_LINES,
  RECENT_PREVIEW_WIDTH,
  RECENT_SESSION_LIMIT,
  SESSION_RECENT_COMMAND,
  type SessionRecentResult,
} from '../contracts/session-recent.js';
import type { SubsystemContext } from '../contracts/subsystem.js';
import { asRecord } from './session-helpers.js';

export interface RecentSessionRecord {
  readonly summary: SessionSummary;
  readonly startedSeq: number;
}

/**
 * The transcript tail per session, kept as a read model rather than queried off
 * the event store: a phone opening cold asks for every recent session at once,
 * and scanning each stream's history per request would make the home screen pay
 * for the whole log.
 *
 * Reasoning and tool events ride `session_output` with an explicit `kind`. An
 * ABSENT kind is text — that is every event persisted before the field existed —
 * so the preview reads it defensively and keeps only text.
 */
export class SessionPreviews {
  private readonly lines = new Map<string, string[]>();

  public project(event: EventEnvelope): void {
    if (event.type !== 'session_output' && event.type !== 'session_input') return;
    const payload = asRecord(event.payload);
    if (!payload) return;
    const kind = payload.kind ?? 'text';
    if (kind !== 'text') return;
    const sessionId = sessionIdOf(event, payload);
    if (!sessionId) return;
    const kept = [...(this.lines.get(sessionId) ?? []), ...previewLines(payload.text)];
    this.lines.set(sessionId, kept.slice(Math.max(0, kept.length - RECENT_PREVIEW_LINES)));
  }

  public preview(sessionId: string): readonly string[] {
    return this.lines.get(sessionId) ?? [];
  }
}

export function recentSessions(
  records: ReadonlyMap<string, RecentSessionRecord>,
  previews: SessionPreviews,
  command: unknown,
): SessionRecentResult {
  const args = recentArgs(command);
  const candidates = [...records.values()]
    // The home is the operator's own work. History opts into ended sessions and can show agent
    // sessions as well; the client still applies its AGENTS preference.
    .filter((record) => args.include_ended || record.summary.origin === 'operator')
    .filter((record) => args.project === undefined || record.summary.project === args.project)
    .filter(
      (record) =>
        record.summary.pinned === true || args.include_ended || !isTerminal(record.summary.status),
    )
    .sort(byRecency);
  const pinned = candidates.filter((record) => record.summary.pinned === true);
  const recent = candidates.filter((record) => record.summary.pinned !== true).slice(0, args.limit);
  return {
    sessions: [...pinned, ...recent].map(({ summary }) => ({
      session_id: summary.session_id,
      label: summary.label,
      provider: summary.provider,
      state: summary.status,
      origin: summary.origin,
      ...(summary.project === undefined ? {} : { project: summary.project }),
      pinned: summary.pinned === true,
      source: summary.source ?? null,
      cwd: summary.cwd ?? '',
      updated_at: summary.updated_at ?? summary.started_at ?? '',
      ...(summary.abort_key === undefined ? {} : { abort_key: summary.abort_key }),
      preview: [...previews.preview(summary.session_id)],
    })),
  };
}

/** Registers the preview read model and the command that reads it. */
export function registerRecentSessions(
  context: SubsystemContext,
  records: ReadonlyMap<string, RecentSessionRecord>,
): void {
  const previews = new SessionPreviews();
  context.registerProjector('session-previews', (event) => previews.project(event), 0);
  context.registerCommand(SESSION_RECENT_COMMAND, (command: unknown) =>
    recentSessions(records, previews, command),
  );
}

function recentArgs(command: unknown): {
  readonly project?: string;
  readonly limit: number;
  readonly include_ended: boolean;
} {
  const value = command === undefined ? {} : asRecord(command);
  if (!value) throw new Error('session.recent command must be an object');
  const project = value.project;
  if (project !== undefined && (typeof project !== 'string' || !project.trim())) {
    throw new Error('project must be a non-empty string');
  }
  const limit = value.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 0)) {
    throw new Error('limit must be a non-negative integer');
  }
  const includeEnded = value.include_ended;
  if (includeEnded !== undefined && typeof includeEnded !== 'boolean') {
    throw new Error('include_ended must be a boolean');
  }
  return {
    ...(project === undefined ? {} : { project }),
    limit: (limit as number | undefined) ?? RECENT_SESSION_LIMIT,
    include_ended: includeEnded === true,
  };
}

function isTerminal(status: SessionSummary['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'stopped';
}

function byRecency(left: RecentSessionRecord, right: RecentSessionRecord): number {
  return (
    activityTime(right.summary) - activityTime(left.summary) || right.startedSeq - left.startedSeq
  );
}

function activityTime(summary: SessionSummary): number {
  const updated = Date.parse(summary.updated_at ?? summary.started_at ?? '');
  return Number.isFinite(updated) ? updated : 0;
}

function sessionIdOf(event: EventEnvelope, payload: Record<string, unknown>): string {
  const explicit = payload.session_id;
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  return event.stream_id.startsWith('session:') ? event.stream_id.slice('session:'.length) : '';
}

function previewLines(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.length > RECENT_PREVIEW_WIDTH ? `${line.slice(0, RECENT_PREVIEW_WIDTH - 1)}…` : line,
    );
}
