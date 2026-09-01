import path from 'node:path';
import { harnessAbortKey } from '../provider/provider.js';
import type {
  SubstrateClient,
  SubstrateSessionInfo,
  SubstrateSessionRecord,
} from '../contracts/substrate-contract.js';
import type { SessionSummary } from '../contracts/session-commands.js';
import type { SessionSummaryRecord } from './session-summary-projector.js';
import type { SessionTable } from './session-table.js';

export interface SubstrateReconciliationOptions {
  readonly table: SessionTable;
  readonly substrate: SubstrateClient;
  readonly sessionRecords: Map<string, SessionSummaryRecord>;
  readonly sessionStorageRoot: string;
  readonly sessionStorageDirs: Map<string, string>;
  readonly now: () => Date;
  readonly reconcileRecord: (record: SubstrateSessionRecord) => Promise<void>;
}

export async function reconcileSubstrateSessions(
  options: SubstrateReconciliationOptions,
): Promise<void> {
  options.table.repairHarnessRefs(options.now().toISOString());
  let listing: readonly SubstrateSessionInfo[] | undefined;
  try {
    listing = await options.substrate.listSessions();
  } catch {
    // Existing records still get their socket-based liveness fallback below.
  }
  if (listing !== undefined) {
    for (const session of listing) {
      if (!session.live) continue;
      const sessionId = sessionIdFromSubstrateName(session.name);
      if (sessionId === undefined) continue;
      const existing = options.table.get(sessionId);
      const adopted = recordForLiveSession(options, session, existing, sessionId);
      if (existing === undefined || existing.substrateName !== session.name) {
        options.table.upsert(adopted);
        console.info(`[session] adopted live substrate session ${session.name}`);
      }
      ensureSummary(options, adopted);
    }
  }
  for (const record of options.table.list()) {
    if (sessionIdFromSubstrateName(record.substrateName) === undefined) continue;
    await options.reconcileRecord(record);
  }
}

function sessionIdFromSubstrateName(name: string): string | undefined {
  const prefix = 'substrate-';
  if (!name.startsWith(prefix)) return undefined;
  const sessionId = name.slice(prefix.length);
  if (!sessionId.trim() || sessionId.includes('/') || sessionId.includes('\0')) return undefined;
  return sessionId;
}

function recordForLiveSession(
  options: SubstrateReconciliationOptions,
  session: SubstrateSessionInfo,
  existing: SubstrateSessionRecord | undefined,
  sessionId: string,
): SubstrateSessionRecord {
  if (existing !== undefined) {
    return {
      ...existing,
      substrateName: session.name,
      updatedAt: options.now().toISOString(),
    };
  }
  const summary = options.sessionRecords.get(sessionId)?.summary;
  const storageDir =
    options.sessionStorageDirs.get(sessionId) ?? path.join(options.sessionStorageRoot, sessionId);
  return {
    sessionId,
    provider: summary?.provider ?? 'omp',
    harnessRef: sessionId,
    substrateName: session.name,
    transcriptPath: path.join(storageDir, 'session.jsonl'),
    storageDir,
    state: 'live',
    label: summary?.label ?? '',
    origin: summary?.origin ?? 'agent',
    ...(summary?.pinned === true ? { pinned: true } : {}),
    ...(summary?.archived === true ? { archived: true } : {}),
    ...(summary?.source === undefined ? {} : { source: summary.source }),
    updatedAt: options.now().toISOString(),
  };
}

function ensureSummary(
  options: SubstrateReconciliationOptions,
  record: SubstrateSessionRecord,
): void {
  if (options.sessionRecords.has(record.sessionId)) return;
  const abortKey = harnessAbortKey(record.provider);
  const summary: SessionSummary = {
    session_id: record.sessionId,
    stream_id: `session:${record.sessionId}`,
    provider: record.provider,
    label: record.label ?? '',
    origin: record.origin ?? 'agent',
    status: 'live',
    started_at: record.updatedAt,
    updated_at: record.updatedAt,
    ...(abortKey === undefined ? {} : { abort_key: abortKey }),
    ...(record.source === undefined || record.source === null ? {} : { source: record.source }),
    ...(record.pinned === true ? { pinned: true } : {}),
    ...(record.archived === true ? { archived: true } : {}),
  };
  options.sessionRecords.set(record.sessionId, { startedSeq: 0, summary });
}
