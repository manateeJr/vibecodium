import type { EventEnvelope } from '../contracts/events.js';
import type { SessionSummary } from '../contracts/session-commands.js';
import { asRecord } from './session-helpers.js';
import type { SessionTable } from './session-table.js';

export interface SessionSummaryRecord {
  summary: SessionSummary;
  readonly startedSeq: number;
}

export interface SessionSummaryProjectionOptions {
  readonly records: Map<string, SessionSummaryRecord>;
  readonly sessionTable?: SessionTable;
  readonly sessionStartStatus: (sessionId: string) => SessionSummary['status'];
  readonly isLive: (sessionId: string) => boolean;
}

export function projectSessionEvent(
  event: EventEnvelope,
  options: SessionSummaryProjectionOptions,
): void {
  const payload = asRecord(event.payload);
  const eventType = event.type as string;
  const payloadSessionId = payload?.session_id;
  const session_id =
    typeof payloadSessionId === 'string' && payloadSessionId.trim()
      ? payloadSessionId
      : event.stream_id.startsWith('session:')
        ? event.stream_id.slice('session:'.length)
        : undefined;
  if (eventType === 'session_started') {
    const provider = payload?.provider;
    const prompt = payload?.prompt;
    if (
      !session_id ||
      typeof provider !== 'string' ||
      !provider.trim() ||
      typeof prompt !== 'string'
    ) {
      return;
    }
    const persisted = options.sessionTable?.get(session_id);
    const origin =
      payload?.origin === 'operator' || payload?.origin === 'agent'
        ? payload.origin
        : (persisted?.origin ?? 'agent');
    options.records.set(session_id, {
      startedSeq: event.seq,
      summary: {
        session_id,
        stream_id: event.stream_id,
        provider,
        label: persisted?.label ?? '',
        origin,
        status: options.sessionStartStatus(session_id),
        prompt,
        started_at: event.ts,
        updated_at: event.ts,
        ...(typeof payload?.project === 'string' ? { project: payload.project } : {}),
        ...(typeof payload?.cwd === 'string' ? { cwd: payload.cwd } : {}),
      },
    });
    return;
  }
  if (!session_id) return;
  const record = options.records.get(session_id);
  if (!record) return;
  const substrateStateEvent =
    eventType === 'session_state' &&
    (payload?.state === 'live' || payload?.state === 'resumable' || payload?.state === 'closed');
  const status = substrateStateEvent
    ? payload?.state === 'live' && options.isLive(session_id)
      ? 'live'
      : 'stopped'
    : eventType === 'verify_failed'
      ? 'failed'
      : eventType === 'session_complete'
        ? 'done'
        : eventType === 'session_stop'
          ? 'stopped'
          : undefined;
  record.summary = {
    ...record.summary,
    updated_at: event.ts,
    ...(status === undefined ? {} : { status }),
  };
}
