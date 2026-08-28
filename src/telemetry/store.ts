import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EventEnvelope, EventKind } from '../contracts/events.js';
import {
  TELEMETRY_SCHEMA_SQL,
  type SignatureStatus,
  type TelemetrySignatureRow,
} from '../contracts/telemetry-schema.js';

export const DEFAULT_TELEMETRY_DB_PATH = path.resolve('.vibecodium/telemetry.db');
export const TELEMETRY_DB_PATH_ENV = 'VIBECODIUM_TELEMETRY_DB_PATH';

export interface TelemetryStoreOptions {
  readonly filename?: string;
  readonly dbPath?: string;
}

type PayloadRecord = Record<string, unknown>;

type SignatureFields = {
  readonly kind: EventKind;
  readonly stage: string;
  readonly normalizedErrorClass: string;
  readonly signature: string;
};

type SignatureDbRow = {
  readonly signature: string;
  readonly kind: EventKind;
  readonly stage: string;
  readonly occurrences: number;
  readonly status: SignatureStatus;
  readonly updated_at: string;
};

/** Host-owned projection store. Session workers never receive this object. */
export class TelemetryStore {
  public readonly filename: string;
  private readonly database: Database.Database;
  private readonly insertEvent: Database.Statement;
  private readonly upsertSignature: Database.Statement;
  private readonly recurringSignaturesQuery: Database.Statement;
  private readonly signatureQuery: Database.Statement;
  private readonly updateStatus: Database.Statement;

  public constructor(options: TelemetryStoreOptions = {}) {
    this.filename = resolveTelemetryDbPath(options);
    if (this.filename !== ':memory:') {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    }
    this.database = new Database(this.filename);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.exec(TELEMETRY_SCHEMA_SQL);
    this.insertEvent = this.database.prepare(`
      INSERT OR IGNORE INTO events (stream_id, seq, kind, stage, payload, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.upsertSignature = this.database.prepare(`
      INSERT INTO signatures (signature, kind, stage, occurrences, status, updated_at)
      VALUES (?, ?, ?, 1, 'open', ?)
      ON CONFLICT(signature) DO UPDATE SET
        occurrences = signatures.occurrences + 1,
        updated_at = excluded.updated_at
    `);
    this.recurringSignaturesQuery = this.database.prepare(`
      SELECT signature, kind, stage, occurrences, status, updated_at
      FROM signatures
      WHERE occurrences >= ?
      ORDER BY occurrences DESC, signature ASC
    `);
    this.signatureQuery = this.database.prepare(`
      SELECT signature, kind, stage, occurrences, status, updated_at
      FROM signatures
      WHERE signature = ?
    `);
    this.updateStatus = this.database.prepare(`
      UPDATE signatures SET status = ?, updated_at = ? WHERE signature = ?
    `);
  }

  /** Fold one globally ordered event; duplicate delivery is idempotent. */
  public projectEvent(event: EventEnvelope): void {
    const fields = signatureFields(event);
    const serializedPayload = JSON.stringify(event.payload);
    if (serializedPayload === undefined) throw new Error('event payload must be JSON serializable');
    const project = this.database.transaction(() => {
      const inserted = this.insertEvent.run(
        event.stream_id,
        event.seq,
        event.type,
        fields?.stage ?? null,
        serializedPayload,
        event.ts,
      );
      if (inserted.changes === 0 || !fields) return;
      this.upsertSignature.run(fields.signature, fields.kind, fields.stage, event.ts);
    });
    project();
  }

  public queryRecurringSignatures(minOccurrences = 3): TelemetrySignatureRow[] {
    validateThreshold(minOccurrences);
    return this.recurringSignaturesQuery.all(minOccurrences) as TelemetrySignatureRow[];
  }

  public getRecurringSignatures(minOccurrences = 3): TelemetrySignatureRow[] {
    return this.queryRecurringSignatures(minOccurrences);
  }

  public getSignature(signature: string): TelemetrySignatureRow | undefined {
    if (!signature.trim()) throw new Error('signature is required');
    return this.signatureQuery.get(signature) as SignatureDbRow | undefined;
  }

  /** New signatures start open; proposal and resolution transitions are external. */
  public setSignatureStatus(signature: string, status: SignatureStatus): boolean {
    if (!signature.trim()) throw new Error('signature is required');
    const updated = this.updateStatus.run(status, new Date().toISOString(), signature);
    return updated.changes > 0;
  }

  public eventCount(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM events').get() as
      { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  public close(): void {
    this.database.close();
  }
}

export function resolveTelemetryDbPath(options: TelemetryStoreOptions = {}): string {
  const configured = options.filename ?? options.dbPath ?? process.env[TELEMETRY_DB_PATH_ENV];
  if (!configured || configured.trim() === '') return DEFAULT_TELEMETRY_DB_PATH;
  if (configured === ':memory:') return configured;
  return path.resolve(configured);
}

export function normalizeErrorClass(value: string): string {
  const firstPart = value.trim().split(/[\r\n:]/u, 1)[0] ?? '';
  const normalized = firstPart
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return normalized || 'unknown';
}

export function signatureFor(kind: EventKind, stage: string, normalizedErrorClass: string): string {
  return createHash('sha256')
    .update([kind, stage, normalizedErrorClass].join('\u0000'), 'utf8')
    .digest('hex');
}

function signatureFields(event: EventEnvelope): SignatureFields | undefined {
  const payload = asRecord(event.payload);
  const stageValue = typeof payload.stage === 'string' ? payload.stage.trim() : '';
  const hasError =
    event.type === 'verify_failed' ||
    typeof payload.error === 'string' ||
    typeof payload.error_class === 'string';
  if (!stageValue || !hasError) return undefined;
  const explicitErrorClass =
    typeof payload.error_class === 'string' ? payload.error_class : undefined;
  const error = typeof payload.error === 'string' ? payload.error : undefined;
  const normalizedErrorClass = normalizeErrorClass(explicitErrorClass ?? error ?? 'unknown');
  return {
    kind: event.type,
    stage: stageValue,
    normalizedErrorClass,
    signature: signatureFor(event.type, stageValue, normalizedErrorClass),
  };
}

function asRecord(value: unknown): PayloadRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as PayloadRecord;
}

function validateThreshold(minOccurrences: number): void {
  if (!Number.isInteger(minOccurrences) || minOccurrences < 1) {
    throw new Error('minOccurrences must be a positive integer');
  }
}
