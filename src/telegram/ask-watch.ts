import type { ActionRequestedPayload } from '../contracts/events.js';

// TEMPORARY MIRROR (issue #116): the canonical AskRequestedFields / AskQuestion /
// AskOption types land in src/contracts/events.ts via the AskProducer lane. These
// mirrors use the exact pinned names and shapes so the pre-integration swap is a
// pure import-source change. Do not extend here; flag drift to L0.
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

export interface AskRequestedFields {
  readonly session_id: string;
  readonly turn: number;
  readonly ask_id: string;
  readonly questions: readonly AskQuestion[];
  readonly source: 'omp-ask';
  readonly requested_at: string;
}

export type AskRequestPayload = ActionRequestedPayload & AskRequestedFields;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Narrow a generic action_requested payload to the omp-ask shape. Returns null
 * for unrelated action requests (proposal approvals, …). The source check
 * tolerates a missing source so pre-integration producer payloads that carry
 * ask_id + questions still match; a conflicting source never matches.
 */
export function asAskRequest(payload: ActionRequestedPayload): AskRequestPayload | null {
  const record = asRecord(payload);
  if (record === null) return null;
  if (asString(record.ask_id) === null) return null;
  if (!Array.isArray(record.questions)) return null;
  const source = record.source;
  if (source !== undefined && source !== 'omp-ask') return null;
  return payload as AskRequestPayload;
}

/** Session that owns the ask; falls back to the subscribed session when absent. */
export function askSessionId(payload: ActionRequestedPayload, fallbackSessionId: string): string {
  const sessionId = asString(asRecord(payload)?.session_id);
  return sessionId ?? fallbackSessionId;
}

/** Session that owns the ask with no fallback; null when the payload is routeless. */
export function askRoutedSessionId(payload: ActionRequestedPayload): string | null {
  return asString(asRecord(payload)?.session_id);
}

export function askTurn(payload: ActionRequestedPayload): number | null {
  const turn = asRecord(payload)?.turn;
  return typeof turn === 'number' && Number.isInteger(turn) ? turn : null;
}

/** Stable dedupe/answer key; the canonical request_id covers pre-ask payloads. */
export function askId(payload: ActionRequestedPayload): string {
  return asString(asRecord(payload)?.ask_id) ?? payload.request_id;
}

export function findAskOption(
  ask: AskRequestPayload,
  questionId: string,
  optionIndex: number,
): AskOption | null {
  const question = ask.questions.find((candidate) => candidate.id === questionId);
  if (question === undefined) return null;
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return null;
  return question.options[optionIndex] ?? null;
}

const DECLINE_OPTION_PATTERN =
  /^(don't|do not|none|skip|decline|cancel|never mind|not now)\b|^no(\s|$)/i;

/**
 * Map a tapped option to the deny path. Narrow carve-out for producer-defined
 * decline options ("Don't file", "No map", …); everything else — including
 * unknown options and unresolvable asks — approves, because the tap itself is
 * consent. Follow-up: producer-owned explicit decline flag on AskOption.
 */
export function isDeclineOption(label: string): boolean {
  return DECLINE_OPTION_PATTERN.test(label.trim());
}

export interface AskAnswerSelection {
  readonly question_id: string;
  readonly option_index: number;
}

export function resolveAskDecision(
  ask: AskRequestPayload | null,
  selection: AskAnswerSelection,
): { readonly approved: boolean } {
  if (ask === null) return { approved: true };
  const option = findAskOption(ask, selection.question_id, selection.option_index);
  if (option === null) return { approved: true };
  return { approved: !isDeclineOption(option.label) };
}

export interface AskSeen {
  has(sessionId: string, askKey: string): boolean;
  add(sessionId: string, askKey: string): void;
  clear(sessionId?: string): void;
}

/** Bounded per-session seen-set mirroring the session-watch relayed/sent pattern. */
export function createAskSeen(limit = 32): AskSeen {
  const seenBySession = new Map<string, Set<string>>();
  return {
    has(sessionId, askKey): boolean {
      return seenBySession.get(sessionId)?.has(askKey) ?? false;
    },
    add(sessionId, askKey): void {
      const seen = seenBySession.get(sessionId) ?? new Set<string>();
      seen.add(askKey);
      while (seen.size > limit) {
        const oldest = seen.values().next().value as string | undefined;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      seenBySession.set(sessionId, seen);
    },
    clear(sessionId): void {
      if (sessionId === undefined) seenBySession.clear();
      else seenBySession.delete(sessionId);
    },
  };
}
