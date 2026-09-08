import type { SubstrateKey, SubstrateSessionState } from './substrate-contract.js';
import type { SessionOrigin, SessionSource } from './session-commands.js';

export type EventKind =
  | 'session_started'
  | 'session_forked'
  | 'session_output'
  | 'session_complete'
  | 'session_input'
  | 'turn_complete'
  | 'verify_failed'
  | 'action_requested'
  | 'action_approved'
  | 'action_denied'
  | 'merge_to_main'
  | 'proposal_queued'
  | 'proposal_approved'
  | 'notify_emitted'
  | 'inbound_received'
  | 'session_state'
  | 'session_context'
  | 'report_received';

export interface SessionStartedPayload {
  readonly session_id: string;
  readonly provider: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly project?: string;
  readonly origin?: SessionOrigin;
  readonly source?: SessionSource;
  readonly abort_key?: SubstrateKey;
}

export interface SessionForkedPayload {
  readonly session_id: string;
  readonly source_session_id: string;
  readonly provider: string;
}

export interface SessionOutputPayload {
  readonly session_id: string;
  readonly index: number;
  readonly text: string;
  readonly kind?: 'text' | 'thinking' | 'tool';
  readonly tool?: {
    readonly name: string;
    readonly summary: string;
    readonly status: 'run' | 'ok' | 'err';
    readonly ms?: number;
  };
}

export interface SessionInputPayload {
  readonly session_id: string;
  readonly turn: number;
  readonly text: string;
  readonly steering?: boolean;
}

export interface SessionCompletePayload {
  readonly session_id: string;
  readonly provider: string;
}

export interface TurnCompletePayload {
  readonly session_id: string;
  readonly turn: number;
}

export interface VerifyFailedPayload {
  readonly stage: string;
  readonly error: string;
  readonly session_id?: string;
  readonly error_class?: string;
  readonly prompt?: string;
}

export interface ActionEventPayload {
  readonly request_id: string;
  readonly action: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly reason?: string;
}

export type ActionRequestedPayload = ActionEventPayload;
export type ActionApprovedPayload = ActionEventPayload;
export type ActionDeniedPayload = ActionEventPayload;

export const ASK_ACTION = 'ask.answer';
export const ASK_SOURCE = 'omp-ask';

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

/** omp ask relay: action_requested carrying the parked ask; base action_* fields stay populated. */
export type AskRequestedPayload = ActionEventPayload & AskRequestedFields;

export interface AskDecisionFields {
  readonly session_id: string;
  readonly ask_id: string;
  readonly question_id: string;
  readonly option_index: number;
}

/**
 * Telegram answer: action_approved carries the picked option; the deny path
 * uses action_denied with the same shape for Don't-ask style options.
 */
export type AskApprovedPayload = ActionEventPayload & AskDecisionFields;
export type AskDeniedPayload = ActionEventPayload & AskDecisionFields;

export function isAskRequestedPayload(value: unknown): value is AskRequestedPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.source === ASK_SOURCE &&
    typeof candidate.ask_id === 'string' &&
    Array.isArray(candidate.questions)
  );
}

export function isAskDecisionPayload(value: unknown): value is AskApprovedPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ask_id === 'string' &&
    typeof candidate.question_id === 'string' &&
    typeof candidate.option_index === 'number'
  );
}

export interface MergeToMainPayload {
  readonly branch: string;
  readonly commit_sha: string;
}

export interface ProposalQueuedPayload {
  readonly proposal_id: string;
  readonly signature: string;
}

export interface ProposalApprovedPayload {
  readonly proposal_id: string;
  readonly signature: string;
}

export interface NotifyEmittedPayload {
  readonly notification_id: string;
  readonly channels: readonly string[];
  readonly severity: string;
}

export interface InboundReceivedPayload {
  readonly source: string;
  readonly request_id?: string;
  readonly capability_token_id?: string;
}

export type SessionStateReason =
  | 'reaped'
  | 'reaped-pressure'
  | 'reconciled'
  | 'shutdown'
  | 'resumed'
  | 'harness-exit'
  | 'liveness-sweep'
  | `resume-failed: ${string}`;

export interface SessionStatePayload {
  readonly session_id: string;
  readonly state: SubstrateSessionState;
  readonly reason: SessionStateReason;
}

export interface SessionContextPayload {
  readonly session_id: string;
  readonly tokens: number;
  readonly model?: string;
  readonly context_window?: number;
}
export interface ReportReceivedPayload {
  readonly report_id: string;
  readonly app: string;
  readonly kind: string;
  readonly title: string;
  readonly summary?: string;
  readonly captured_at: string;
}

export interface EventPayloadMap {
  readonly session_started: SessionStartedPayload;
  readonly session_output: SessionOutputPayload;
  readonly session_complete: SessionCompletePayload;
  readonly session_input: SessionInputPayload;
  readonly turn_complete: TurnCompletePayload;
  readonly verify_failed: VerifyFailedPayload;
  readonly action_requested: ActionRequestedPayload;
  readonly action_approved: ActionApprovedPayload;
  readonly action_denied: ActionDeniedPayload;
  readonly merge_to_main: MergeToMainPayload;
  readonly proposal_queued: ProposalQueuedPayload;
  readonly proposal_approved: ProposalApprovedPayload;
  readonly notify_emitted: NotifyEmittedPayload;
  readonly inbound_received: InboundReceivedPayload;
  readonly session_forked: SessionForkedPayload;
  readonly session_state: SessionStatePayload;
  readonly session_context: SessionContextPayload;
  readonly report_received: ReportReceivedPayload;
}

export type EventPayload<K extends EventKind = EventKind> = EventPayloadMap[K];

export interface EventEnvelope<K extends EventKind = EventKind> {
  readonly stream_id: string;
  readonly seq: number;
  readonly type: K;
  readonly payload: EventPayload<K>;
  readonly ts: string;
}
