import type { SessionState } from './worker-lifecycle.js';
import type { SessionTable } from './session-table.js';

export function stopAllSessions(
  sessionTable: SessionTable | undefined,
  sessions: Map<string, SessionState>,
  markResumable: (sessionId: string) => void,
  shutdownPersistent: () => void,
): void {
  const substrateSessionIds = new Set<string>();
  for (const record of sessionTable?.list() ?? []) {
    if (record.state !== 'live') continue;
    substrateSessionIds.add(record.sessionId);
    markResumable(record.sessionId);
  }
  for (const state of sessions.values()) {
    if (substrateSessionIds.has(state.session_id)) {
      state.terminal = true;
      continue;
    }
    state.terminal = true;
    if (state.worker.connected || !state.worker.killed) state.worker.kill();
  }
  sessions.clear();
  shutdownPersistent();
}
