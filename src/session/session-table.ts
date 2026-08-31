import Database from 'better-sqlite3';
import type { SessionOrigin, SessionSource } from '../contracts/session-commands.js';
import { harnessRefFromTranscriptPath } from './transcript-ref.js';
import type {
  SubstrateSessionRecord,
  SubstrateSessionState,
} from '../contracts/substrate-contract.js';

export interface SessionTableOptions {
  readonly filename?: string;
  readonly database?: Database.Database;
}

type SessionRow = {
  session_id: string;
  provider: string;
  harness_ref: string;
  substrate_name: string;
  transcript_path: string;
  storage_dir: string;
  state: SubstrateSessionState;
  label: string;
  origin: SessionOrigin;
  pinned: number;
  source: SessionSource | null;
  updated_at: string;
};

const sessionTableSchema = `
  CREATE TABLE IF NOT EXISTS session_records (
    session_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    harness_ref TEXT NOT NULL,
    substrate_name TEXT NOT NULL,
    transcript_path TEXT NOT NULL,
    storage_dir TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('live', 'resumable', 'closed')),
    label TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('operator', 'agent')),
    pinned INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_records_state ON session_records (state);
`;

export class SessionTable {
  private readonly database: Database.Database;
  private readonly ownsDatabase: boolean;
  private readonly upsertRecord;
  private readonly readRecord;
  private readonly readRecords;
  private readonly updateRecordState;
  private readonly updateRecordLabel;
  private readonly updateRecordPinned;
  private closed = false;

  public constructor(options: SessionTableOptions = {}) {
    if (options.database !== undefined && options.filename !== undefined) {
      throw new Error('session table accepts a database or filename, not both');
    }
    this.ownsDatabase = options.database === undefined;
    this.database = options.database ?? new Database(options.filename ?? ':memory:');
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.exec(sessionTableSchema);
    migrateSessionTable(this.database);
    this.upsertRecord = this.database.prepare(`
      INSERT INTO session_records (
        session_id, provider, harness_ref, substrate_name,
        transcript_path, storage_dir, state, label, origin, pinned, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        harness_ref = excluded.harness_ref,
        substrate_name = excluded.substrate_name,
        transcript_path = excluded.transcript_path,
        storage_dir = excluded.storage_dir,
        state = excluded.state,
        label = excluded.label,
        origin = excluded.origin,
        pinned = excluded.pinned,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);
    this.readRecord = this.database.prepare(`
      SELECT session_id, provider, harness_ref, substrate_name,
             transcript_path, storage_dir, state, label, origin, pinned, source, updated_at
      FROM session_records
      WHERE session_id = ?
    `);
    this.readRecords = this.database.prepare(`
      SELECT session_id, provider, harness_ref, substrate_name,
             transcript_path, storage_dir, state, label, origin, pinned, source, updated_at
      FROM session_records
      ORDER BY updated_at DESC, session_id ASC
    `);
    this.updateRecordState = this.database.prepare(
      'UPDATE session_records SET state = ?, updated_at = ? WHERE session_id = ?',
    );
    this.updateRecordLabel = this.database.prepare(
      'UPDATE session_records SET label = ?, updated_at = ? WHERE session_id = ?',
    );
    this.updateRecordPinned = this.database.prepare(
      'UPDATE session_records SET pinned = ? WHERE session_id = ?',
    );
  }

  public upsert(record: SubstrateSessionRecord): SubstrateSessionRecord {
    const derivedHarnessRef = harnessRefFromTranscriptPath(record.transcriptPath);
    const persisted =
      derivedHarnessRef === undefined || derivedHarnessRef === record.harnessRef
        ? record
        : { ...record, harnessRef: derivedHarnessRef };
    validateRecord(persisted);
    this.upsertRecord.run(
      persisted.sessionId,
      persisted.provider,
      persisted.harnessRef,
      persisted.substrateName,
      persisted.transcriptPath,
      persisted.storageDir,
      persisted.state,
      persisted.label ?? '',
      persisted.origin ?? 'agent',
      persisted.pinned === true ? 1 : 0,
      persisted.source ?? null,
      persisted.updatedAt,
    );
    return persisted;
  }

  public get(sessionId: string): SubstrateSessionRecord | undefined {
    validateSessionId(sessionId);
    const row = this.readRecord.get(sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : recordFromRow(row);
  }

  public list(): readonly SubstrateSessionRecord[] {
    return (this.readRecords.all() as SessionRow[]).map(recordFromRow);
  }

  public updateState(
    sessionId: string,
    state: SubstrateSessionState,
    updatedAt = new Date().toISOString(),
  ): SubstrateSessionRecord {
    validateSessionId(sessionId);
    validateState(state);
    if (!updatedAt.trim()) throw new Error('updatedAt is required');
    const result = this.updateRecordState.run(state, updatedAt, sessionId);
    if (result.changes === 0) throw new Error(`session record not found: ${sessionId}`);
    const record = this.get(sessionId);
    if (record === undefined) throw new Error(`session record disappeared: ${sessionId}`);
    return record;
  }
  public rename(
    sessionId: string,
    label: string,
    updatedAt = new Date().toISOString(),
  ): SubstrateSessionRecord {
    validateSessionId(sessionId);
    if (!label.trim()) throw new Error('label is required');
    if (!updatedAt.trim()) throw new Error('updatedAt is required');
    const result = this.updateRecordLabel.run(label.trim(), updatedAt, sessionId);
    if (result.changes === 0) throw new Error(`session record not found: ${sessionId}`);
    const record = this.get(sessionId);
    if (record === undefined) throw new Error(`session record disappeared: ${sessionId}`);
    return record;
  }
  public setPinned(sessionId: string, pinned: boolean): SubstrateSessionRecord {
    validateSessionId(sessionId);
    if (typeof pinned !== 'boolean') throw new Error('pinned must be a boolean');
    const result = this.updateRecordPinned.run(pinned ? 1 : 0, sessionId);
    if (result.changes === 0) throw new Error(`session record not found: ${sessionId}`);
    const record = this.get(sessionId);
    if (record === undefined) throw new Error(`session record disappeared: ${sessionId}`);
    return record;
  }

  public repairHarnessRefs(updatedAt = new Date().toISOString()): number {
    let repaired = 0;
    for (const record of this.list()) {
      const derivedHarnessRef = harnessRefFromTranscriptPath(record.transcriptPath);
      if (
        record.harnessRef !== record.sessionId ||
        derivedHarnessRef === undefined ||
        derivedHarnessRef === record.harnessRef
      ) {
        continue;
      }
      this.upsert({ ...record, harnessRef: derivedHarnessRef, updatedAt });
      repaired += 1;
    }
    return repaired;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) this.database.close();
  }
}

function recordFromRow(row: SessionRow): SubstrateSessionRecord {
  return {
    sessionId: row.session_id,
    provider: row.provider,
    harnessRef: row.harness_ref,
    substrateName: row.substrate_name,
    transcriptPath: row.transcript_path,
    storageDir: row.storage_dir,
    state: row.state,
    label: row.label,
    origin: row.origin,
    ...(row.pinned === 0 ? {} : { pinned: true }),
    ...(row.source === null ? {} : { source: row.source }),
    updatedAt: row.updated_at,
  };
}

function migrateSessionTable(database: Database.Database): void {
  const columns = new Set(
    (database.pragma('table_info(session_records)') as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('label')) {
    database.exec("ALTER TABLE session_records ADD COLUMN label TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('origin')) {
    database.exec("ALTER TABLE session_records ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'");
  }
  if (!columns.has('pinned')) {
    database.exec('ALTER TABLE session_records ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('source')) {
    database.exec('ALTER TABLE session_records ADD COLUMN source TEXT');
  }
}

function validateRecord(record: SubstrateSessionRecord): void {
  validateSessionId(record.sessionId);
  for (const [name, value] of [
    ['provider', record.provider],
    ['harnessRef', record.harnessRef],
    ['substrateName', record.substrateName],
    ['transcriptPath', record.transcriptPath],
    ['storageDir', record.storageDir],
    ['updatedAt', record.updatedAt],
  ] as const) {
    if (!value.trim()) throw new Error(`${name} is required`);
  }
  if (record.label !== undefined && typeof record.label !== 'string') {
    throw new Error('label must be a string');
  }
  if (record.origin !== undefined) validateOrigin(record.origin);
  if (record.pinned !== undefined && typeof record.pinned !== 'boolean') {
    throw new Error('pinned must be a boolean');
  }
  if (record.source !== undefined && record.source !== null) validateSource(record.source);
  validateState(record.state);
}

function validateSource(source: SessionSource): void {
  if (source !== 'pocket' && source !== 'cli' && source !== 'api') {
    throw new Error(`invalid source: ${source}`);
  }
}
function validateOrigin(origin: SessionOrigin): void {
  if (origin !== 'operator' && origin !== 'agent') throw new Error(`invalid origin: ${origin}`);
}
function validateSessionId(sessionId: string): void {
  if (!sessionId.trim()) throw new Error('sessionId is required');
}

function validateState(state: SubstrateSessionState): void {
  if (state !== 'live' && state !== 'resumable' && state !== 'closed') {
    throw new Error(`invalid session state: ${state}`);
  }
}
