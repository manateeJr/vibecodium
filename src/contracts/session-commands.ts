import type { SubstrateKey, SubstrateSessionState } from './substrate-contract.js';

export interface SessionOpenArgs {
  readonly provider: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly project?: string;
}

export interface SessionOpenResult {
  readonly session_id: string;
  readonly stream_id: string;
}

export interface SessionResumeArgs {
  readonly source: 'omp' | 'codex';
  readonly ref: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly project?: string;
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
}

export interface SessionSendResult {
  readonly stream_id: string;
  readonly turn: number;
}

export interface SessionListArgs {
  readonly project?: string;
  readonly limit?: number;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: string;
  readonly project?: string;
  readonly cwd?: string;
  readonly status: 'live' | 'done' | 'failed' | 'stopped';
  readonly prompt?: string;
  readonly started_at?: string;
  readonly updated_at?: string;
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

/** Consumed by the PC-side attach CLI. */
export interface SessionAttachInfoArgs {
  readonly session_id: string;
}

export interface SessionAttachInfoResult {
  readonly substrate_name: string;
  readonly abduco_bin_path: string;
  readonly state: SubstrateSessionState;
}

/**
 * PTY frames are EPHEMERAL transport messages and are NEVER persisted to the
 * event log.
 */
export interface PtySubscribeFrame {
  readonly type: 'pty_subscribe';
  readonly session_id: string;
}

export interface PtyUnsubscribeFrame {
  readonly type: 'pty_unsubscribe';
  readonly session_id: string;
}

export interface PtyDataFrame {
  readonly type: 'pty';
  readonly session_id: string;
  readonly data_b64: string;
}

export type PtyClientFrame = PtySubscribeFrame | PtyUnsubscribeFrame;
export type PtyServerFrame = PtyDataFrame;
