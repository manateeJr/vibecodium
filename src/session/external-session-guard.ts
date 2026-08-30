import { stat } from 'node:fs/promises';
import type { MachineSessionResolver, ResolvedMachineSession } from '../machine-sessions/index.js';
import type { SessionSummaryRecord } from './session-summary-projector.js';
import type { SessionTable } from './session-table.js';

const DEFAULT_EXTERNAL_ACTIVE_WINDOW_MS = 90_000;
const ACTIVE_SESSION_ERROR =
  'external session appears active on this machine — try again when it goes idle';

export async function assertExternalSessionIdle(
  session: ResolvedMachineSession,
  now: () => number = Date.now,
): Promise<void> {
  let modifiedAt: number;
  try {
    modifiedAt = (await stat(session.path)).mtimeMs;
  } catch {
    return;
  }
  const age = now() - modifiedAt;
  if (Number.isFinite(age) && age < externalActiveWindowMs()) {
    throw new Error(ACTIVE_SESSION_ERROR);
  }
}

function externalActiveWindowMs(): number {
  const configured = Number(process.env.VIBECODIUM_EXTERNAL_ACTIVE_WINDOW_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_EXTERNAL_ACTIVE_WINDOW_MS;
}
export interface ExternalResumeStorage {
  readonly storageDir: string;
  readonly transcriptPath: string;
}

export async function resolveExternalSession(
  resolver: MachineSessionResolver | undefined,
  source: 'omp' | 'codex',
  ref: string,
  now: () => number,
): Promise<ResolvedMachineSession | undefined> {
  const resolved = await resolver?.resolve(ref);
  if (!resolved || resolved.source !== source) return undefined;
  await assertExternalSessionIdle(resolved, now);
  return resolved;
}

export function hydrateExternalSession(
  records: Map<string, SessionSummaryRecord>,
  table: SessionTable | undefined,
  sessionId: string,
  external: ResolvedMachineSession,
): void {
  const record = records.get(sessionId);
  if (record) record.summary = { ...record.summary, label: external.title };
  const persisted = table?.get(sessionId);
  if (table && persisted) table.upsert({ ...persisted, label: external.title, origin: 'agent' });
}
