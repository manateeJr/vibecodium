import { cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  SessionAttachInfoArgs,
  SessionAttachInfoResult,
  SessionEnsureLiveArgs,
  SessionForkResult,
  SessionListResult,
  SessionOpenArgs,
  SessionResumeArgs,
  SessionSendArgs,
  SessionSendKeysArgs,
  SessionStopArgs,
  SessionSummary,
} from '../contracts/commands.js';
import type { SubstrateKey } from '../contracts/substrate-contract.js';
import { abducoBinaryPath } from '../substrate/paths.js';
import type { SessionTable } from './session-table.js';
import type { SubsystemContext } from '../contracts/subsystem.js';

export async function copySessionStore(
  sourcePath: string,
  targetStorageDir: string,
): Promise<void> {
  let sourceStats;
  try {
    sourceStats = await stat(sourcePath);
  } catch {
    throw new Error(`session store not found at ${sourcePath}`);
  }
  if (sourceStats.isDirectory()) {
    await cp(sourcePath, targetStorageDir, { recursive: true, force: false, errorOnExist: true });
    return;
  }
  await mkdir(targetStorageDir);
  await cp(sourcePath, path.join(targetStorageDir, path.basename(sourcePath)), {
    force: false,
    errorOnExist: true,
  });
}

export function continueCommand(provider: string, session_id: string, storageDir: string): string {
  const quotedStorageDir = /^[A-Za-z0-9_./:-]+$/.test(storageDir)
    ? storageDir
    : `'${storageDir.replaceAll("'", "'\\''")}'`;
  if (provider === 'omp' || provider === 'claude') {
    return `${provider} --resume ${session_id} --session-dir ${quotedStorageDir}`;
  }
  if (provider === 'codex') return `codex resume ${session_id}`;
  return `${provider} --resume ${session_id} --session-dir ${quotedStorageDir}`;
}

export function sessionOpenArgs(command: unknown): SessionOpenArgs {
  const value = asRecord(command);
  if (!value || typeof value.provider !== 'string' || !value.provider.trim())
    throw new Error('provider is required');
  if (typeof value.prompt !== 'string') throw new Error('prompt is required');
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd.trim()))
    throw new Error('cwd must be a non-empty string');
  if (value.project !== undefined && (typeof value.project !== 'string' || !value.project.trim()))
    throw new Error('project must be a non-empty string');
  return {
    provider: value.provider,
    prompt: value.prompt,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.project === undefined ? {} : { project: value.project }),
  };
}

export function sessionResumeArgs(command: unknown): SessionResumeArgs {
  const value = asRecord(command);
  if (!value || (value.source !== 'omp' && value.source !== 'codex'))
    throw new Error('source must be omp or codex');
  if (typeof value.ref !== 'string' || !value.ref.trim()) throw new Error('ref is required');
  if (typeof value.prompt !== 'string') throw new Error('prompt is required');
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd.trim()))
    throw new Error('cwd must be a non-empty string');
  if (value.project !== undefined && (typeof value.project !== 'string' || !value.project.trim()))
    throw new Error('project must be a non-empty string');
  return {
    source: value.source,
    ref: value.ref,
    prompt: value.prompt,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.project === undefined ? {} : { project: value.project }),
  };
}

export function sessionSendArgs(command: unknown): SessionSendArgs {
  const value = asRecord(command);
  if (!value || typeof value.session_id !== 'string' || !value.session_id.trim())
    throw new Error('session_id is required');
  if (typeof value.prompt !== 'string') throw new Error('prompt is required');
  return { session_id: value.session_id, prompt: value.prompt };
}

export function sessionEnsureLiveArgs(command: unknown): SessionEnsureLiveArgs {
  const value = asRecord(command);
  if (!value || typeof value.session_id !== 'string' || !value.session_id.trim()) {
    throw new Error('session_id is required');
  }
  return { session_id: value.session_id };
}

export function sessionAttachInfoArgs(command: unknown): SessionAttachInfoArgs {
  const value = asRecord(command);
  if (!value || typeof value.session_id !== 'string' || !value.session_id.trim()) {
    throw new Error('session_id is required');
  }
  return { session_id: value.session_id };
}

export function sessionAttachInfo(
  table: SessionTable | undefined,
  command: unknown,
): SessionAttachInfoResult {
  const args = sessionAttachInfoArgs(command);
  if (!table) throw new Error('session table is not configured');
  const record = table.get(args.session_id);
  if (!record) throw new Error('session not found');
  return {
    substrate_name: record.substrateName,
    abduco_bin_path: abducoBinaryPath(),
    state: record.state,
  };
}

export function sessionSendKeysArgs(command: unknown): SessionSendKeysArgs {
  const value = asRecord(command);
  if (!value || typeof value.session_id !== 'string' || !value.session_id.trim()) {
    throw new Error('session_id is required');
  }
  if (
    !Array.isArray(value.keys) ||
    value.keys.some(
      (key) => key !== 'ctrl_u' && key !== 'enter' && key !== 'escape' && key !== 'interrupt',
    )
  ) {
    throw new Error('keys must contain valid substrate keys');
  }
  return { session_id: value.session_id, keys: value.keys as SubstrateKey[] };
}

export function sessionStopArgs(command: unknown): SessionStopArgs {
  const value = asRecord(command);
  if (!value || typeof value.session_id !== 'string' || !value.session_id.trim())
    throw new Error('session_id is required');
  return { session_id: value.session_id };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
interface SessionRecordLike {
  readonly summary: SessionSummary;
  readonly startedSeq: number;
}

export interface ForkSessionOptions {
  readonly context: SubsystemContext;
  readonly sessionRecords: ReadonlyMap<string, SessionRecordLike>;
  readonly idFactory: () => string;
  readonly sessionStorageRoot: string;
  readonly sessionStorageDirs: Map<string, string>;
}

export function listSessions(
  records: ReadonlyMap<string, SessionRecordLike>,
  command: unknown,
): SessionListResult {
  const value = command === undefined ? {} : asRecord(command);
  if (!value) throw new Error('session.list command must be an object');
  const project = value.project;
  if (project !== undefined && (typeof project !== 'string' || !project.trim())) {
    throw new Error('project must be a non-empty string');
  }
  const limitValue = value.limit;
  if (limitValue !== undefined && (!Number.isInteger(limitValue) || (limitValue as number) < 0)) {
    throw new Error('limit must be a non-negative integer');
  }
  const limit = (limitValue as number | undefined) ?? 10;
  const sessions = [...records.values()]
    .filter((record) => project === undefined || record.summary.project === project)
    .sort((left, right) => {
      const leftStarted = left.summary.started_at
        ? Date.parse(left.summary.started_at)
        : Number.NaN;
      const rightStarted = right.summary.started_at
        ? Date.parse(right.summary.started_at)
        : Number.NaN;
      const leftTimestamp = Number.isFinite(leftStarted) ? leftStarted : 0;
      const rightTimestamp = Number.isFinite(rightStarted) ? rightStarted : 0;
      return rightTimestamp - leftTimestamp || right.startedSeq - left.startedSeq;
    })
    .slice(0, limit)
    .map((record) => record.summary);
  return { sessions };
}

export async function forkSession(
  command: unknown,
  options: ForkSessionOptions,
): Promise<SessionForkResult> {
  const value = asRecord(command);
  if (!value || typeof value.session_id !== 'string' || !value.session_id.trim()) {
    throw new Error('session_id is required');
  }
  const session_id = value.session_id;
  const source = options.sessionRecords.get(session_id);
  if (!source) throw new Error('session not found');
  const new_session_id = options.idFactory();
  if (
    !new_session_id.trim() ||
    new_session_id === session_id ||
    new_session_id.includes('/') ||
    new_session_id.includes('\\') ||
    options.sessionRecords.has(new_session_id)
  ) {
    throw new Error('forked session id is invalid or already exists');
  }
  const sourcePath = await findSessionStorePath(
    options.sessionStorageDirs.get(session_id),
    options.sessionStorageRoot,
    session_id,
  );
  const targetStorageDir = path.join(options.sessionStorageRoot, new_session_id);
  await copySessionStore(sourcePath, targetStorageDir);
  options.sessionStorageDirs.set(new_session_id, targetStorageDir);
  const stream_id = `session:${new_session_id}`;
  const prompt = source.summary.prompt ?? '';
  options.context.append(stream_id, 'session_started', {
    session_id: new_session_id,
    provider: source.summary.provider,
    prompt,
    ...(source.summary.cwd === undefined ? {} : { cwd: source.summary.cwd }),
    ...(source.summary.project === undefined ? {} : { project: source.summary.project }),
  });
  options.context.append(stream_id, 'session_forked', {
    session_id: new_session_id,
    source_session_id: session_id,
    provider: source.summary.provider,
  });
  return {
    new_session_id,
    provider: source.summary.provider,
    continue_command: continueCommand(source.summary.provider, new_session_id, targetStorageDir),
  };
}

export async function findSessionStorePath(
  knownPath: string | undefined,
  sessionStorageRoot: string,
  session_id: string,
): Promise<string> {
  const candidates = [
    knownPath,
    path.join(sessionStorageRoot, session_id),
    path.join(sessionStorageRoot, `${session_id}.jsonl`),
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next provider storage shape.
    }
  }
  throw new Error(`session store not found for ${session_id}`);
}
