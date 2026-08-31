import type { SubstrateKey, SubstrateSessionState } from './substrate-contract.js';
import type { SessionOrigin } from './session-commands.js';

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
  | 'session_state';

export interface SessionStartedPayload {
  readonly session_id: string;
  readonly provider: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly project?: string;
  readonly origin?: SessionOrigin;
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
  'reaped' | 'reconciled' | 'shutdown' | 'resumed' | `resume-failed: ${string}`;

export interface SessionStatePayload {
  readonly session_id: string;
  readonly state: SubstrateSessionState;
  readonly reason: SessionStateReason;
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
}

export type EventPayload<K extends EventKind = EventKind> = EventPayloadMap[K];

export interface EventEnvelope<K extends EventKind = EventKind> {
  readonly stream_id: string;
  readonly seq: number;
  readonly type: K;
  readonly payload: EventPayload<K>;
  readonly ts: string;
}
