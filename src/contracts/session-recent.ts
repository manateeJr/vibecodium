import type { SessionOrigin, SessionSummary } from './session-commands.js';

/**
 * The cold-start home: the operator's last few sessions, each with the tail of
 * what was said in it, so a phone that opens with no active session shows work
 * to resume instead of an empty transcript.
 */
export const SESSION_RECENT_COMMAND = 'session.recent';

/** Rows the home shows by default, and lines of transcript under each row. */
export const RECENT_SESSION_LIMIT = 5;
export const RECENT_PREVIEW_LINES = 3;
/** A preview line never exceeds this; a phone row has no room for more. */
export const RECENT_PREVIEW_WIDTH = 90;

export interface SessionRecentArgs {
  readonly limit?: number;
}

export interface RecentSession {
  readonly session_id: string;
  readonly label: string;
  readonly provider: string;
  readonly state: SessionSummary['status'];
  readonly origin: SessionOrigin;
  readonly cwd: string;
  readonly updated_at: string;
  readonly abort_key?: SessionSummary['abort_key'];
  /** Oldest first, at most RECENT_PREVIEW_LINES entries. */
  readonly preview: readonly string[];
}

export interface SessionRecentResult {
  readonly sessions: readonly RecentSession[];
}
