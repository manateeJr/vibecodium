import type { SessionSummary } from '../contracts/session-commands.js';
import type {
  SubstrateClient,
  SubstrateSessionInfo,
  SubstrateSessionState,
} from '../contracts/substrate-contract.js';
import type { SessionSummaryRecord } from './session-summary-projector.js';
import type { SessionTable } from './session-table.js';

const CACHE_MS = 250;
const PROBE_TIMEOUT_MS = 750;
type CachedRefresh = { readonly at: number; readonly promise: Promise<void> };
const refreshCache = new WeakMap<object, CachedRefresh>();

/** Refreshes read-model status from abduco without making session.recent block indefinitely. */
export function refreshSessionLiveness(
  substrate: SubstrateClient | undefined,
  records: ReadonlyMap<string, SessionSummaryRecord>,
  sessionTable: SessionTable | undefined,
  reconciled: Set<string>,
): Promise<void> {
  if (substrate === undefined) return Promise.resolve();
  const now = Date.now();
  const cached = refreshCache.get(records);
  if (cached !== undefined && now - cached.at < CACHE_MS) return cached.promise;
  const promise = readAndApply(substrate, records, sessionTable, reconciled);
  refreshCache.set(records, { at: now, promise });
  return promise;
}

export function createSessionLivenessRefresh(
  substrate: SubstrateClient,
  records: ReadonlyMap<string, SessionSummaryRecord>,
  sessionTable: SessionTable | undefined,
  reconciled: Set<string>,
): () => Promise<void> {
  return () => refreshSessionLiveness(substrate, records, sessionTable, reconciled);
}

async function readAndApply(
  substrate: SubstrateClient,
  records: ReadonlyMap<string, SessionSummaryRecord>,
  sessionTable: SessionTable | undefined,
  reconciled: Set<string>,
): Promise<void> {
  const sessions = await listSessionsBounded(substrate);
  if (sessions === undefined) return;
  const liveNames = new Set(
    sessions.filter((session) => session.live).map((session) => session.name),
  );
  for (const [sessionId, record] of records) {
    const persisted = sessionTable?.get(sessionId);
    const substrateName = persisted?.substrateName ?? `substrate-${sessionId}`;
    const status = liveNames.has(substrateName)
      ? 'live'
      : statusWhenSubstrateIsAbsent(record.summary.status, persisted?.state);
    if (status === 'live') reconciled.add(sessionId);
    else reconciled.delete(sessionId);
    if (record.summary.status !== status) record.summary = { ...record.summary, status };
  }
}

function statusWhenSubstrateIsAbsent(
  current: SessionSummary['status'],
  persisted: SubstrateSessionState | undefined,
): SessionSummary['status'] {
  if (persisted === 'closed') return 'stopped';
  if (persisted === 'live' || persisted === 'resumable') return 'resumable';
  return current === 'live' ? 'stopped' : current;
}

async function listSessionsBounded(
  substrate: SubstrateClient,
): Promise<readonly SubstrateSessionInfo[] | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([substrate.listSessions(), timeout]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
