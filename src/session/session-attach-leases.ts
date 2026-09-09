import type { SubsystemContext } from '../contracts/subsystem.js';
import {
  SESSION_ATTACH_HEARTBEAT_COMMAND,
  SESSION_ATTACH_RELEASE_COMMAND,
} from '../contracts/session-commands.js';
import { sessionAttachHeartbeat, sessionAttachRelease } from './session-helpers.js';
import type { SessionTable } from './session-table.js';
import type Database from 'better-sqlite3';

/** Default attach-lease TTL when the client omits ttl_ms or sends a non-positive value. */
export const ATTACH_LEASE_DEFAULT_TTL_MS = 30_000;

/** Upper bound for a client-requested attach-lease TTL. */
export const ATTACH_LEASE_MAX_TTL_MS = 120_000;

/**
 * Clamp a client-requested TTL to the server policy: a positive finite
 * request is capped at the maximum, anything else falls back to the default.
 */
export function effectiveAttachTtl(requested?: unknown): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.floor(requested), ATTACH_LEASE_MAX_TTL_MS);
  }
  return ATTACH_LEASE_DEFAULT_TTL_MS;
}

const attachLeasesSchema = `
  CREATE TABLE IF NOT EXISTS session_attach_leases (
    session_id TEXT PRIMARY KEY,
    substrate_name TEXT NOT NULL,
    lease_until_ms INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

type AttachLeaseRow = {
  session_id: string;
  substrate_name: string;
  lease_until_ms: number;
  updated_at: string;
};

/**
 * Crash-safe attach leases: a terminal sitting attached holds a short-TTL
 * lease row, so the idle reaper can skip leased sessions. Leases expire by
 * TTL alone — a crashed terminal simply stops heartbeating and its row goes
 * stale, so no release path is needed for safety.
 *
 * Stateless over a shared better-sqlite3 handle: the handler instance in
 * session/index.ts and the reaper-side instance in the persistent manager
 * both operate on this table with no in-memory cache.
 */
export class SessionAttachLeases {
  private readonly upsertLease;
  private readonly deleteLease;
  private readonly readLease;
  private readonly deleteExpired;

  public constructor(db: Database.Database) {
    db.exec(attachLeasesSchema);
    this.upsertLease = db.prepare(`
      INSERT INTO session_attach_leases (
        session_id, substrate_name, lease_until_ms, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        substrate_name = excluded.substrate_name,
        lease_until_ms = excluded.lease_until_ms,
        updated_at = excluded.updated_at
    `);
    this.deleteLease = db.prepare('DELETE FROM session_attach_leases WHERE session_id = ?');
    this.readLease = db.prepare(`
      SELECT session_id, substrate_name, lease_until_ms, updated_at
      FROM session_attach_leases
      WHERE session_id = ?
    `);
    this.deleteExpired = db.prepare('DELETE FROM session_attach_leases WHERE lease_until_ms <= ?');
  }

  /** Upsert the lease to now + effective TTL; returns lease_until_ms. */
  public heartbeat(sessionId: string, substrateName: string, ttlMs?: number): number {
    if (!sessionId.trim()) throw new Error('sessionId is required');
    if (!substrateName.trim()) throw new Error('substrateName is required');
    const leaseUntilMs = Date.now() + effectiveAttachTtl(ttlMs);
    this.upsertLease.run(sessionId, substrateName, leaseUntilMs, new Date().toISOString());
    return leaseUntilMs;
  }

  /** Idempotent delete; a missing row is a no-op. */
  public release(sessionId: string): void {
    if (!sessionId.trim()) throw new Error('sessionId is required');
    this.deleteLease.run(sessionId);
  }

  /** True while a row exists with lease_until_ms strictly after nowMs. */
  public isLeased(sessionId: string, nowMs: number): boolean {
    if (!sessionId.trim()) throw new Error('sessionId is required');
    const row = this.readLease.get(sessionId) as AttachLeaseRow | undefined;
    return row !== undefined && row.lease_until_ms > nowMs;
  }

  /** Delete expired rows; returns the number removed. */
  public prune(nowMs: number): number {
    const result = this.deleteExpired.run(nowMs);
    return Number(result.changes);
  }
}

/**
 * Persistence options spread for the persistent manager: the co-located
 * session table handle plus the canonical attach-lease store.
 */
export interface AttachLeaseStores {
  readonly sessionTable: SessionTable;
  readonly attachLeases: SessionAttachLeases;
}

/**
 * Build the SINGLE canonical attach-lease store for the subsystem, register
 * the attach_heartbeat/attach_release commands, and return the manager
 * options spread — one call so session/index.ts stays under the file cap.
 * The handlers and the reaper shield share this instance over one table;
 * returns an empty spread when no session table is configured.
 */
export function registerAttachLeases(
  context: Pick<SubsystemContext, 'registerCommand'>,
  sessionTable: SessionTable | undefined,
): AttachLeaseStores | Record<string, never> {
  if (sessionTable === undefined) return {};
  const attachLeases = new SessionAttachLeases(sessionTable.databaseHandle);
  context.registerCommand(SESSION_ATTACH_HEARTBEAT_COMMAND, (command: unknown) =>
    sessionAttachHeartbeat(attachLeases, sessionTable, command),
  );
  context.registerCommand(SESSION_ATTACH_RELEASE_COMMAND, (command: unknown) =>
    sessionAttachRelease(attachLeases, command),
  );
  return { sessionTable, attachLeases };
}
