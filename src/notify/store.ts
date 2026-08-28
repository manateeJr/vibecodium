import Database from 'better-sqlite3';
import fs from 'node:fs';
import type { EventKind } from '../contracts/events.js';
import type {
  CapabilityTokenClaims,
  NotificationSeverity,
  NotifyRule,
  QuietHours,
} from './types.js';

export interface NotifyLogRow {
  readonly notification_id: string;
  readonly signature: string;
  readonly stream_id: string;
  readonly event_seq: number;
  readonly event_kind: EventKind;
  readonly severity: NotificationSeverity;
  readonly channels: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly occurrences: number;
  readonly status: 'pending' | 'delivered' | 'failed' | 'suppressed';
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly delivered_at: string | null;
  readonly suppressed_reason: string | null;
}

export interface CapabilityTokenRow {
  readonly token_id: string;
  readonly proposal_id: string;
  readonly action: string;
  readonly kid: string;
  readonly token_hash: string;
  readonly expires_at: string;
  readonly used_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

export interface NotifyStoreOptions {
  readonly filename: string;
}

export interface NotificationRecordInput {
  readonly notification_id: string;
  readonly signature: string;
  readonly stream_id: string;
  readonly event_seq: number;
  readonly event_kind: EventKind;
  readonly severity: NotificationSeverity;
  readonly channels: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly now: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notify_rules (
  event_kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  channels TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_kind, severity)
);
CREATE TABLE IF NOT EXISTS notify_log (
  notification_id TEXT PRIMARY KEY,
  signature TEXT NOT NULL UNIQUE,
  stream_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  channels TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'suppressed')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  delivered_at TEXT,
  suppressed_reason TEXT
);
CREATE INDEX IF NOT EXISTS notify_log_last_seen ON notify_log (last_seen_at);
CREATE TABLE IF NOT EXISTS notify_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capability_tokens (
  token_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  kid TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capability_tokens_proposal ON capability_tokens (proposal_id);
CREATE TABLE IF NOT EXISTS inbound_replays (
  replay_key TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
`;

export class NotifyStore {
  private readonly database: Database.Database;
  private readonly insertRule;
  private readonly selectRule;
  private readonly selectRules;
  private readonly deleteRule;
  private readonly insertNotification;
  private readonly incrementNotification;
  private readonly selectNotificationBySignature;
  private readonly selectNotificationById;
  private readonly selectNotifications;
  private readonly updateNotificationStatus;
  private readonly selectSetting;
  private readonly upsertSetting;
  private readonly writeCapabilityToken;
  private readonly selectCapabilityToken;
  private readonly claimCapabilityTokenStatement;
  private readonly insertReplay;
  private readonly purgeReplays;

  public constructor(options: NotifyStoreOptions) {
    if (options.filename !== ':memory:') {
      const directory = options.filename.slice(0, Math.max(options.filename.lastIndexOf('/'), 0));
      if (directory) fs.mkdirSync(directory, { recursive: true });
    }
    this.database = new Database(options.filename);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.exec(SCHEMA);
    this.insertRule = this.database.prepare(
      `INSERT INTO notify_rules (event_kind, severity, channels, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_kind, severity) DO UPDATE SET
         channels = excluded.channels, enabled = excluded.enabled, updated_at = excluded.updated_at`,
    );
    this.selectRule = this.database.prepare(
      'SELECT event_kind, severity, channels, enabled FROM notify_rules WHERE event_kind = ? AND severity = ?',
    );
    this.selectRules = this.database.prepare(
      'SELECT event_kind, severity, channels, enabled FROM notify_rules ORDER BY event_kind, severity',
    );
    this.deleteRule = this.database.prepare(
      'DELETE FROM notify_rules WHERE event_kind = ? AND severity = ?',
    );
    this.insertNotification = this.database.prepare(`
      INSERT INTO notify_log
        (notification_id, signature, stream_id, event_seq, event_kind, severity, channels,
         title, body, occurrences, status, first_seen_at, last_seen_at, delivered_at, suppressed_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, NULL, NULL)
      ON CONFLICT(signature) DO NOTHING
    `);
    this.incrementNotification = this.database.prepare(
      'UPDATE notify_log SET occurrences = occurrences + 1, last_seen_at = ? WHERE signature = ?',
    );
    this.selectNotificationBySignature = this.database.prepare(
      'SELECT * FROM notify_log WHERE signature = ?',
    );
    this.selectNotificationById = this.database.prepare(
      'SELECT * FROM notify_log WHERE notification_id = ?',
    );
    this.selectNotifications = this.database.prepare(
      'SELECT * FROM notify_log ORDER BY first_seen_at ASC',
    );
    this.updateNotificationStatus = this.database.prepare(`
      UPDATE notify_log
      SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
          suppressed_reason = CASE WHEN ? = 'suppressed' THEN ? ELSE suppressed_reason END
      WHERE notification_id = ?
    `);
    this.selectSetting = this.database.prepare('SELECT value FROM notify_settings WHERE key = ?');
    this.upsertSetting = this.database.prepare(`
      INSERT INTO notify_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.writeCapabilityToken = this.database.prepare(`
      INSERT INTO capability_tokens
        (token_id, proposal_id, action, kid, token_hash, expires_at, used_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `);
    this.selectCapabilityToken = this.database.prepare(
      'SELECT * FROM capability_tokens WHERE token_hash = ?',
    );
    this.claimCapabilityTokenStatement = this.database.prepare(`
      UPDATE capability_tokens SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL
    `);
    this.insertReplay = this.database.prepare(
      'INSERT INTO inbound_replays (replay_key, seen_at) VALUES (?, ?) ON CONFLICT(replay_key) DO NOTHING',
    );
    this.purgeReplays = this.database.prepare('DELETE FROM inbound_replays WHERE seen_at < ?');
  }

  public seedRule(rule: NotifyRule, now: string): void {
    this.insertRule.run(
      rule.event_kind,
      rule.severity,
      JSON.stringify([...rule.channels]),
      rule.enabled === false ? 0 : 1,
      now,
    );
  }

  public setRule(rule: NotifyRule, now: string): void {
    this.seedRule(rule, now);
  }

  public removeRule(event_kind: string, severity: string): boolean {
    return this.deleteRule.run(event_kind, severity).changes > 0;
  }

  public rules(): NotifyRule[] {
    return (this.selectRules.all() as NotifyRuleRow[]).map((row) => ({
      event_kind: row.event_kind as EventKind | '*',
      severity: row.severity as NotificationSeverity | '*',
      channels: parseChannels(row.channels),
      enabled: row.enabled !== 0,
    }));
  }

  public route(event_kind: EventKind, severity: NotificationSeverity): readonly string[] {
    const candidates = [
      [event_kind, severity],
      [event_kind, '*'],
      ['*', severity],
      ['*', '*'],
    ] as const;
    for (const [kind, level] of candidates) {
      const row = this.selectRule.get(kind, level) as NotifyRuleRow | undefined;
      if (row) return row.enabled === 0 ? [] : parseChannels(row.channels);
    }
    return [];
  }

  public getMasterSwitch(): boolean {
    const value = this.setting('master_switch');
    return value === undefined ? true : value === 'on';
  }

  public setMasterSwitch(enabled: boolean): void {
    this.upsertSetting.run('master_switch', enabled ? 'on' : 'off');
  }

  public getQuietHours(): QuietHours | null {
    const value = this.setting('quiet_hours');
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!isQuietHours(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  public setQuietHours(quietHours: QuietHours | null): void {
    this.upsertSetting.run('quiet_hours', quietHours ? JSON.stringify(quietHours) : '');
  }

  public recordNotification(input: NotificationRecordInput): { row: NotifyLogRow; first: boolean } {
    const result = this.insertNotification.run(
      input.notification_id,
      input.signature,
      input.stream_id,
      input.event_seq,
      input.event_kind,
      input.severity,
      JSON.stringify([...input.channels]),
      input.title,
      input.body,
      input.now,
      input.now,
    );
    const first = result.changes > 0;
    if (!first) this.incrementNotification.run(input.now, input.signature);
    const row = this.selectNotificationBySignature.get(input.signature) as
      NotifyLogRowDb | undefined;
    if (!row) throw new Error('notification record was not persisted');
    return { row: toNotifyLogRow(row), first };
  }

  public markNotification(
    notification_id: string,
    status: NotifyLogRow['status'],
    now: string,
    reason?: string,
  ): void {
    this.updateNotificationStatus.run(status, status, now, status, reason ?? null, notification_id);
  }

  public notification(notification_id: string): NotifyLogRow | undefined {
    const row = this.selectNotificationById.get(notification_id) as NotifyLogRowDb | undefined;
    return row ? toNotifyLogRow(row) : undefined;
  }

  public notifications(): NotifyLogRow[] {
    return (this.selectNotifications.all() as NotifyLogRowDb[]).map(toNotifyLogRow);
  }

  public insertCapabilityToken(
    claims: CapabilityTokenClaims,
    token_hash: string,
    created_at: string,
  ): void {
    this.writeCapabilityToken.run(
      claims.token_id,
      claims.proposal_id,
      claims.action,
      claims.kid,
      token_hash,
      new Date(claims.expires_at * 1000).toISOString(),
      created_at,
    );
  }

  public capabilityToken(token_hash: string): CapabilityTokenRow | undefined {
    return this.selectCapabilityToken.get(token_hash) as CapabilityTokenRow | undefined;
  }

  public claimCapabilityToken(token_hash: string, used_at: string): boolean {
    return this.claimCapabilityTokenStatement.run(used_at, token_hash).changes === 1;
  }

  public revokeCapabilityToken(token_hash: string, revoked_at: string): boolean {
    const result = this.database
      .prepare(
        'UPDATE capability_tokens SET revoked_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL',
      )
      .run(revoked_at, token_hash);
    return result.changes === 1;
  }
  public rememberReplay(replay_key: string, now: string, retain_after: string): boolean {
    this.purgeReplays.run(retain_after);
    return this.insertReplay.run(replay_key, now).changes === 1;
  }

  public close(): void {
    this.database.close();
  }

  private setting(key: string): string | undefined {
    const row = this.selectSetting.get(key) as { value?: string } | undefined;
    return row?.value;
  }
}

type NotifyRuleRow = {
  readonly event_kind: string;
  readonly severity: string;
  readonly channels: string;
  readonly enabled: number;
};

type NotifyLogRowDb = {
  readonly notification_id: string;
  readonly signature: string;
  readonly stream_id: string;
  readonly event_seq: number;
  readonly event_kind: string;
  readonly severity: string;
  readonly channels: string;
  readonly title: string;
  readonly body: string;
  readonly occurrences: number;
  readonly status: NotifyLogRow['status'];
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly delivered_at: string | null;
  readonly suppressed_reason: string | null;
};

function parseChannels(serialized: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(serialized);
    return Array.isArray(value) && value.every((channel) => typeof channel === 'string')
      ? value
      : [];
  } catch {
    return [];
  }
}

function toNotifyLogRow(row: NotifyLogRowDb): NotifyLogRow {
  return {
    notification_id: row.notification_id,
    signature: row.signature,
    stream_id: row.stream_id,
    event_seq: row.event_seq,
    event_kind: row.event_kind as EventKind,
    severity: row.severity as NotificationSeverity,
    channels: parseChannels(row.channels),
    title: row.title,
    body: row.body,
    occurrences: row.occurrences,
    status: row.status,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    delivered_at: row.delivered_at,
    suppressed_reason: row.suppressed_reason,
  };
}

function isQuietHours(value: unknown): value is QuietHours {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.start === 'string' &&
    typeof candidate.end === 'string' &&
    (candidate.timezone === undefined ||
      candidate.timezone === 'local' ||
      candidate.timezone === 'UTC')
  );
}
