import {
  SESSION_ATTACH_HEARTBEAT_COMMAND,
  SESSION_ATTACH_RELEASE_COMMAND,
  type SessionAttachHeartbeatArgs,
  type SessionAttachHeartbeatResult,
  type SessionAttachReleaseArgs,
  type SessionAttachReleaseResult,
} from '../contracts/session-commands.js';
import { post } from './index.js';

/**
 * session.attach_heartbeat transport (issue #118). Lives in this module —
 * instead of a createClient method — so src/client/index.ts stays under the
 * file cap. The attach CLI calls this on its heartbeat interval; substrate
 * and TTL default server-side, so `{ session_id }` alone suffices.
 */
export function postSessionAttachHeartbeat(
  baseUrl: string,
  args: SessionAttachHeartbeatArgs,
  token?: string,
): Promise<SessionAttachHeartbeatResult> {
  return post<SessionAttachHeartbeatResult>(baseUrl, SESSION_ATTACH_HEARTBEAT_COMMAND, args, token);
}

/**
 * session.attach_release transport (issue #118). Best-effort: callers ignore
 * rejection — a missed release expires by TTL on its own.
 */
export function postSessionAttachRelease(
  baseUrl: string,
  args: SessionAttachReleaseArgs,
  token?: string,
): Promise<SessionAttachReleaseResult> {
  return post<SessionAttachReleaseResult>(baseUrl, SESSION_ATTACH_RELEASE_COMMAND, args, token);
}
