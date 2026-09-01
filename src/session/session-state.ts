import type { SubstrateSessionState } from '../contracts/substrate-contract.js';
import type { SessionSummaryRecord } from './session-summary-projector.js';

export function applySessionSubstrateState(
  records: ReadonlyMap<string, SessionSummaryRecord>,
  session_id: string,
  state: SubstrateSessionState,
  updatedAt: string,
): void {
  const record = records.get(session_id);
  if (!record) return;
  const status: SessionSummaryRecord['summary']['status'] =
    state === 'live' ? 'live' : state === 'resumable' ? 'resumable' : 'stopped';
  const summary = {
    ...record.summary,
    status,
    updated_at: updatedAt,
  };
  if (state === 'live') delete summary.pending_prompt;
  record.summary = summary;
}
