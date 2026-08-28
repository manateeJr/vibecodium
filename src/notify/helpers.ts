import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { EventEnvelope, EventKind } from '../contracts/events.js';
import type {
  HmacKeyRing,
  InboundCommand,
  NotificationAction,
  NotificationSeverity,
  NotifyOptions,
  NotifyRule,
  QuietHours,
} from './types.js';

export function databasePath(options: NotifyOptions): string {
  return (
    options.dbPath ??
    options.filename ??
    process.env.VIBECODIUM_NOTIFY_DB_PATH ??
    path.join(process.cwd(), '.vibecodium', 'notify.db')
  );
}

export function defaultKeyRing(prefix: string, defaultKid: string): HmacKeyRing {
  const currentSecret = process.env[`${prefix}_SECRET`] ?? randomBytes(32).toString('hex');
  const currentKid = process.env[`${prefix}_KID`] ?? defaultKid;
  const previousSecret = process.env[`${prefix}_PREVIOUS_SECRET`];
  const previousKid = process.env[`${prefix}_PREVIOUS_KID`];
  return {
    current: { kid: currentKid, secret: currentSecret },
    ...(previousSecret && previousKid
      ? { previous: { kid: previousKid, secret: previousSecret } }
      : {}),
  };
}

export function normalizeInboundBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('inbound base URL must use HTTP or HTTPS');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function validateRule(rule: NotifyRule): void {
  if (!rule.event_kind || (!isEventKind(rule.event_kind) && rule.event_kind !== '*')) {
    throw new Error('notification rule event_kind is invalid');
  }
  if (!rule.severity || !['info', 'warn', 'action', '*'].includes(rule.severity)) {
    throw new Error('notification rule severity is invalid');
  }
  if (rule.channels.some((channel) => !channel.trim() || /[\r\n]/.test(channel))) {
    throw new Error('notification rule channels must be non-empty');
  }
}

export function validateQuietHours(quietHours: QuietHours): void {
  if (parseClock(quietHours.start) === undefined || parseClock(quietHours.end) === undefined) {
    throw new Error('quiet hours must use HH:MM');
  }
}

export function severityFor(event: EventEnvelope): NotificationSeverity {
  const payload = asRecord(event.payload);
  const configured = payload?.severity;
  if (configured === 'info' || configured === 'warn' || configured === 'action') return configured;
  if (
    event.type === 'action_requested' ||
    event.type === 'action_approved' ||
    event.type === 'action_denied'
  ) {
    return 'action';
  }
  if (event.type === 'verify_failed') return 'warn';
  return 'info';
}

export function inQuietHours(now: Date, quietHours: QuietHours | null): boolean {
  if (!quietHours) return false;
  const start = parseClock(quietHours.start);
  const end = parseClock(quietHours.end);
  if (start === undefined || end === undefined || start === end) return false;
  const current =
    quietHours.timezone === 'UTC'
      ? now.getUTCHours() * 60 + now.getUTCMinutes()
      : now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function notificationSignature(
  event: EventEnvelope,
  severity: NotificationSeverity,
): string {
  return createHash('sha256')
    .update(`${event.type}:${severity}:${canonicalJson(event.payload)}`)
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function capabilityActions(token: string, baseUrl: string): readonly NotificationAction[] {
  const encoded = encodeURIComponent(token);
  const endpoint = `${baseUrl}/notify/capability`;
  return [
    { label: 'Approve', url: `${endpoint}?token=${encoded}&decision=approve`, method: 'POST' },
    { label: 'Reject', url: `${endpoint}?token=${encoded}&decision=reject`, method: 'POST' },
  ];
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  const record = asRecord(value);
  if (!record || !Object.values(record).every((entry) => typeof entry === 'string'))
    return undefined;
  return record as Record<string, string>;
}

export function stringOr(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === 'string' && value ? value : fallback;
}

function isEventKind(value: string): value is EventKind {
  return [
    'session_started',
    'session_output',
    'session_complete',
    'verify_failed',
    'action_requested',
    'action_approved',
    'action_denied',
    'merge_to_main',
    'proposal_queued',
    'proposal_approved',
    'notify_emitted',
    'inbound_received',
  ].includes(value);
}

function parseClock(value: string): number | undefined {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
  if (!match) return undefined;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

export function parseRule(value: unknown): NotifyRule | undefined {
  const record = asRecord(value);
  if (!record || typeof record.event_kind !== 'string' || typeof record.severity !== 'string')
    return undefined;
  if (
    !Array.isArray(record.channels) ||
    !record.channels.every((channel) => typeof channel === 'string')
  ) {
    return undefined;
  }
  const enabled = record.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') return undefined;
  return {
    event_kind: record.event_kind as NotifyRule['event_kind'],
    severity: record.severity as NotifyRule['severity'],
    channels: record.channels,
    ...(enabled === undefined ? {} : { enabled }),
  };
}

export function parseQuietHours(value: unknown): QuietHours | undefined {
  const record = asRecord(value);
  if (!record || typeof record.start !== 'string' || typeof record.end !== 'string')
    return undefined;
  const timezone = record.timezone;
  if (timezone !== undefined && timezone !== 'local' && timezone !== 'UTC') return undefined;
  const result: QuietHours = {
    start: record.start,
    end: record.end,
    ...(timezone === undefined ? {} : { timezone }),
  };
  return parseClock(result.start) === undefined || parseClock(result.end) === undefined
    ? undefined
    : result;
}

export function isInboundCommand(value: unknown): value is InboundCommand {
  const record = asRecord(value);
  if (!record || (record.type !== 'capability' && record.type !== 'inbox')) return false;
  if (record.type === 'capability') {
    return (
      typeof record.token === 'string' &&
      (record.decision === undefined ||
        record.decision === 'approve' ||
        record.decision === 'reject')
    );
  }
  return typeof record.body === 'string' && !!asRecord(record.headers);
}
