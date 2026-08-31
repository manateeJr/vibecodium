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
  record.summary = {
    ...record.summary,
    status: state === 'live' ? 'live' : 'stopped',
    updated_at: updatedAt,
  };
}
