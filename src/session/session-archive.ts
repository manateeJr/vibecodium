import type { SessionArchiveResult } from '../contracts/session-commands.js';
import { sessionArchiveArgs } from './session-helpers.js';
import type { SessionSummaryRecord } from './session-summary-projector.js';
import type { SessionTable } from './session-table.js';

export function archiveSession(
  records: ReadonlyMap<string, SessionSummaryRecord>,
  table: SessionTable | undefined,
  command: unknown,
): SessionArchiveResult {
  const args = sessionArchiveArgs(command);
  const record = records.get(args.session_id);
  if (!record) throw new Error('session not found');
  if (table?.get(args.session_id) !== undefined) table.setArchived(args.session_id, args.archived);
  if (args.archived) record.summary = { ...record.summary, archived: true };
  else {
    const summary = { ...record.summary };
    delete summary.archived;
    record.summary = summary;
  }
  return { archived: args.archived };
}
