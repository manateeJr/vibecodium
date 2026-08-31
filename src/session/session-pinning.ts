import type { SessionPinResult } from '../contracts/session-commands.js';
import { sessionPinArgs } from './session-helpers.js';
import type { SessionSummaryRecord } from './session-summary-projector.js';
import type { SessionTable } from './session-table.js';

export function pinSession(
  records: ReadonlyMap<string, SessionSummaryRecord>,
  table: SessionTable | undefined,
  command: unknown,
): SessionPinResult {
  const args = sessionPinArgs(command);
  const record = records.get(args.session_id);
  if (!record) throw new Error('session not found');
  if (table?.get(args.session_id) !== undefined) table.setPinned(args.session_id, args.pinned);
  if (args.pinned) record.summary = { ...record.summary, pinned: true };
  else {
    const summary = { ...record.summary };
    delete summary.pinned;
    record.summary = summary;
  }
  return { pinned: args.pinned };
}
