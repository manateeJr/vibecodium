import type { SubstrateKey, SubstrateSessionState } from './substrate-contract.js';
export type SessionSource = 'pocket' | 'cli' | 'api';
export type SessionOrigin = 'operator' | 'agent';

export interface SessionOpenArgs {
  readonly provider: string;
  readonly prompt?: string;
  readonly cwd?: string;
  readonly project?: string;
  readonly model?: string;
  readonly origin?: SessionOrigin;
  readonly source?: SessionSource;
}

export interface SessionOpenResult {
  readonly session_id: string;
  readonly stream_id: string;
}
export interface SessionRenameArgs {
  readonly session_id: string;
  readonly label: string;
}

export interface SessionRenameResult {
  readonly label: string;
}

export interface SessionResumeArgs {
  readonly source: 'omp' | 'codex';
  readonly ref: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly project?: string;
  readonly origin?: SessionOrigin;
}

export type SessionResumeResult = SessionOpenResult;

export interface SessionStopArgs {
  readonly session_id: string;
}

export interface SessionStopResult {
  readonly stopped: boolean;
}

export interface SessionSendArgs {
  readonly session_id: string;
  readonly prompt: string;
  readonly idempotency_key?: string;
}

export interface SessionSendResult {
  readonly stream_id: string;
  readonly turn: number;
}

export interface SessionListArgs {
  readonly project?: string;
  readonly limit?: number;
  readonly scope?: 'active' | 'archived';
}

export interface SessionSummary {
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: string;
  readonly label: string;
  readonly origin: SessionOrigin;
  readonly project?: string;
  readonly cwd?: string;
  readonly status: 'live' | 'resumable' | 'done' | 'failed' | 'stopped';
  readonly prompt?: string;
  readonly pending_prompt?: string;
  readonly started_at?: string;
  readonly updated_at?: string;
  readonly abort_key?: SubstrateKey;
  readonly source?: SessionSource;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

export interface SessionPinArgs {
  readonly session_id: string;
  readonly pinned: boolean;
}

export interface SessionPinResult {
  readonly pinned: boolean;
}

export interface SessionArchiveArgs {
  readonly session_id: string;
  readonly archived: boolean;
}

export interface SessionArchiveResult {
  readonly archived: boolean;
}

export interface SessionListResult {
  readonly sessions: readonly SessionSummary[];
}

export interface SessionForkArgs {
  readonly session_id: string;
}

export interface SessionForkResult {
  readonly new_session_id: string;
  readonly provider: string;
  readonly continue_command: string;
}

/**
 * Relaunches a resumable session under the substrate via the harness resume
 * path; a no-op returning the current state when already live.
 */
export interface SessionEnsureLiveArgs {
  readonly session_id: string;
}

export interface SessionEnsureLiveResult {
  readonly state: SubstrateSessionState;
  readonly substrate_name: string;
}

/** Raw named-control-key passthrough for phone steer/interrupt. */
export interface SessionSendKeysArgs {
  readonly session_id: string;
  readonly keys: readonly SubstrateKey[];
}

export interface SessionSendKeysResult {
  readonly sent: number;
}

/**
 * Telegram ask-relay answer (issue #116). Records the tapped option as
 * action_approved / action_denied on the session stream and resolves the
 * pending omp ask so the turn can proceed.
 */
export interface SessionAnswerAskArgs {
  readonly session_id: string;
  readonly ask_id: string;
  readonly question_id: string;
  readonly option_index: number;
  readonly approved: boolean;
}

export interface SessionAnswerAskResult {
  readonly status: 'approved' | 'denied';
  readonly resolved: boolean;
}

/** Command name for session.answer_ask; kept here so commands.ts stays untouched. */
export const SESSION_ANSWER_ASK_COMMAND = 'session.answer_ask';

/** Consumed by the PC-side attach CLI. */
export interface SessionAttachInfoArgs {
  readonly session_id: string;
}

export interface SessionAttachInfoResult {
  readonly substrate_name: string;
  readonly abduco_bin_path: string;
  readonly state: SubstrateSessionState;
  readonly socket_dir?: string;
}

/**
 * Terminal-held attach lease heartbeat (issue #118). An attached terminal
 * refreshes its lease on an interval; the idle reaper skips leased sessions.
 */
export interface SessionAttachHeartbeatArgs {
  readonly session_id: string;
  readonly substrate_name?: string;
  readonly ttl_ms?: number;
}

export interface SessionAttachHeartbeatResult {
  readonly lease_until_ms: number;
}

export interface SessionAttachReleaseArgs {
  readonly session_id: string;
}

export interface SessionAttachReleaseResult {
  readonly released: boolean;
}

/** Command names for attach leases; wired into COMMAND_NAMES in commands.ts. */
export const SESSION_ATTACH_HEARTBEAT_COMMAND = 'session.attach_heartbeat';
export const SESSION_ATTACH_RELEASE_COMMAND = 'session.attach_release';

/**
 * PTY frames are EPHEMERAL transport messages and are NEVER persisted to the
 * event log.
 */
export interface PtySubscribeFrame {
  readonly type: 'pty_subscribe';
  readonly session_id: string;
  readonly token?: string;
}
export interface PtyUnsubscribeFrame {
  readonly type: 'pty_unsubscribe';
  readonly session_id: string;
  readonly token?: string;
}

export interface PtyDataFrame {
  readonly type: 'pty';
  readonly session_id: string;
  readonly data_b64: string;
}

export type PtyClientFrame = PtySubscribeFrame | PtyUnsubscribeFrame;
export type PtyServerFrame = PtyDataFrame;
