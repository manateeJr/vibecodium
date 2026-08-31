import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  REPORT_BODY_FILENAME,
  REPORT_METADATA_FILENAME,
  REPORT_RETENTION_MS,
  type ReportAttachment,
  type ReportRecord,
} from '../contracts/report-commands.js';

const DEFAULT_SHARED_ROOT = path.join(os.homedir(), '.vibecodium', 'shared');
const SAFE_REPORT_ID = /^[a-zA-Z0-9-]+$/;
const DEFAULT_ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';

export interface ReportStoreOptions {
  readonly sharedRoot?: string;
  readonly now?: () => number;
}

export interface ReportEnvelope {
  readonly app: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly capturedAt: string;
  readonly title: string;
  readonly summary?: string;
  readonly device?: string;
  readonly note?: string;
  readonly body: unknown;
}

export interface ReportAttachmentInput {
  readonly filename: string;
  readonly contentType?: string;
  readonly data: Buffer;
}

export class ReportStore {
  public readonly sharedRoot: string;
  private readonly now: () => number;

  public constructor(options: ReportStoreOptions = {}) {
    this.sharedRoot = path.resolve(
      options.sharedRoot ?? process.env.VIBECODIUM_SHARED_DIR ?? DEFAULT_SHARED_ROOT,
    );
    this.now = options.now ?? Date.now;
  }

  public async create(
    envelope: ReportEnvelope,
    attachments: readonly ReportAttachmentInput[],
  ): Promise<ReportRecord> {
    const createdAtDate = new Date(this.now());
    const createdAt = createdAtDate.toISOString();
    const serializedBody = JSON.stringify(envelope.body, null, 2);
    if (serializedBody === undefined) throw new Error('report body must be JSON serializable');
    const id = randomUUID();
    const directory = this.directoryPath(id);
    const normalizedAttachments = attachments.map((attachment) => normalizeAttachment(attachment));
    const attachmentRecords: ReportAttachment[] = normalizedAttachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      bytes: attachment.data.byteLength,
    }));
    const record: ReportRecord = {
      id,
      app: envelope.app,
      kind: envelope.kind,
      schemaVersion: envelope.schemaVersion,
      capturedAt: envelope.capturedAt,
      title: envelope.title,
      ...(envelope.summary === undefined ? {} : { summary: envelope.summary }),
      ...(envelope.device === undefined ? {} : { device: envelope.device }),
      ...(envelope.note === undefined ? {} : { note: envelope.note }),
      pinned: false,
      createdAt,
      expiresAt: new Date(createdAtDate.getTime() + REPORT_RETENTION_MS).toISOString(),
      attachments: attachmentRecords,
    };
    await mkdir(directory, { recursive: true });
    await writeFile(this.bodyPath(id), serializedBody, { flag: 'wx' });
    for (const attachment of normalizedAttachments) {
      await writeFile(path.join(directory, attachment.filename), attachment.data, { flag: 'wx' });
    }
    await writeFile(
      path.join(directory, REPORT_METADATA_FILENAME),
      JSON.stringify(record, null, 2),
      { flag: 'wx' },
    );
    return record;
  }

  public async list(limit?: number): Promise<readonly ReportRecord[]> {
    validateLimit(limit);
    const entries = await this.directoryEntries();
    const reports: ReportRecord[] = [];
    const currentTime = this.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const report = await this.readRecord(entry.name);
        if (isExpired(report, currentTime)) continue;
        reports.push(report);
      } catch {
        // A malformed neighbour must not hide healthy reports.
      }
    }
    reports.sort((left, right) => {
      const createdDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return createdDifference || right.id.localeCompare(left.id);
    });
    return limit === undefined ? reports : reports.slice(0, limit);
  }

  public async get(
    id: string,
  ): Promise<{ readonly report: ReportRecord; readonly body: unknown; readonly bodyPath: string }> {
    const safeId = safeReportId(id);
    let report: ReportRecord;
    try {
      report = await this.readRecord(safeId);
      if (isExpired(report, this.now())) throw new Error('expired');
    } catch {
      throw new Error('report not found');
    }
    const bodyPath = this.bodyPath(safeId);
    try {
      const body = JSON.parse(await readFile(bodyPath, 'utf8')) as unknown;
      return { report, body, bodyPath };
    } catch {
      throw new Error('report not found');
    }
  }

  public async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const safeId = safeReportId(id);
    let report: ReportRecord;
    try {
      report = await this.readRecord(safeId);
    } catch {
      return false;
    }
    const updated: ReportRecord = { ...report, pinned };
    await writeFile(
      path.join(this.directoryPath(safeId), REPORT_METADATA_FILENAME),
      JSON.stringify(updated, null, 2),
    );
    return true;
  }

  public async dismiss(id: string): Promise<boolean> {
    const safeId = safeReportId(id);
    const directory = this.directoryPath(safeId);
    let existed = false;
    try {
      await lstat(directory);
      existed = true;
    } catch {
      existed = false;
    }
    await rm(directory, { recursive: true, force: true });
    return existed;
  }

  public attachmentPaths(record: ReportRecord): readonly string[] {
    const safeId = safeReportId(record.id);
    return record.attachments.map((attachment) =>
      path.join(this.directoryPath(safeId), safeAttachmentFilename(attachment.filename)),
    );
  }

  public bodyPath(id: string): string {
    return path.join(this.directoryPath(safeReportId(id)), REPORT_BODY_FILENAME);
  }

  public async sweep(): Promise<number> {
    const entries = await this.directoryEntries();
    const currentTime = this.now();
    let pruned = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const report = await this.readRecord(entry.name);
        if (!isExpired(report, currentTime)) continue;
        await rm(this.directoryPath(entry.name), { recursive: true, force: true });
        pruned += 1;
      } catch {
        // Ignore malformed reports and neighbours removed concurrently.
      }
    }
    return pruned;
  }

  private directoryPath(id: string): string {
    return path.join(this.sharedRoot, safeReportId(id));
  }

  private async directoryEntries(): Promise<readonly Dirent[]> {
    try {
      return await readdir(this.sharedRoot, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
  }

  private async readRecord(id: string): Promise<ReportRecord> {
    const metadataPath = path.join(this.directoryPath(id), REPORT_METADATA_FILENAME);
    const parsed = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
    if (!isReportRecord(parsed) || parsed.id !== id) throw new Error('invalid report metadata');
    return parsed;
  }
}

export function normalizeEnvelope(payload: unknown, now: Date): ReportEnvelope {
  const capturedAt = now.toISOString();
  const value = asRecord(payload);
  if (value && typeof value.app === 'string' && hasOwn(value, 'body')) {
    const envelopeCapturedAt = nonEmptyString(value.capturedAt) ?? capturedAt;
    const title = nonEmptyString(value.title) ?? `Report ${envelopeCapturedAt}`;
    const kind = nonEmptyString(value.kind) ?? 'raw';
    const schemaVersion =
      typeof value.schemaVersion === 'number' && Number.isFinite(value.schemaVersion)
        ? value.schemaVersion
        : 1;
    const summary = nonEmptyString(value.summary);
    const device = nonEmptyString(value.device);
    const note = nonEmptyString(value.note);
    return {
      app: value.app,
      kind,
      schemaVersion,
      capturedAt: envelopeCapturedAt,
      title,
      ...(summary === undefined ? {} : { summary }),
      ...(device === undefined ? {} : { device }),
      ...(note === undefined ? {} : { note }),
      body: value.body,
    };
  }
  return {
    app: 'unknown',
    kind: 'raw',
    schemaVersion: 1,
    capturedAt,
    title: `Report ${capturedAt}`,
    body: payload,
  };
}

function normalizeAttachment(input: ReportAttachmentInput): {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Buffer;
} {
  return {
    filename: safeAttachmentFilename(input.filename),
    contentType: nonEmptyString(input.contentType) ?? DEFAULT_ATTACHMENT_CONTENT_TYPE,
    data: input.data,
  };
}

function safeReportId(id: string): string {
  if (typeof id !== 'string' || !SAFE_REPORT_ID.test(id)) {
    throw new Error('id must be a plain UUID-ish token');
  }
  return id;
}

function safeAttachmentFilename(filename: string): string {
  if (typeof filename !== 'string' || filename.includes('\0')) {
    throw new Error('attachment filename is invalid');
  }
  const basename = path.basename(filename.replaceAll('\\', '/'));
  if (!basename || basename === '.' || basename === '..') {
    throw new Error('attachment filename is invalid');
  }
  return basename;
}

function isExpired(report: ReportRecord, now: number): boolean {
  return !report.pinned && Date.parse(report.expiresAt) < now;
}

function validateLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error('limit must be a non-negative integer');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isReportRecord(value: unknown): value is ReportRecord {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    !SAFE_REPORT_ID.test(record.id) ||
    typeof record.app !== 'string' ||
    typeof record.kind !== 'string' ||
    typeof record.schemaVersion !== 'number' ||
    !Number.isFinite(record.schemaVersion) ||
    typeof record.capturedAt !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.pinned !== 'boolean' ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    !Array.isArray(record.attachments)
  ) {
    return false;
  }
  for (const key of ['summary', 'device', 'note']) {
    if (hasOwn(record, key) && typeof record[key] !== 'string') return false;
  }
  return record.attachments.every((attachment) => {
    const item = asRecord(attachment);
    return (
      item !== undefined &&
      typeof item.filename === 'string' &&
      typeof item.contentType === 'string' &&
      typeof item.bytes === 'number' &&
      Number.isFinite(item.bytes) &&
      item.bytes >= 0
    );
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
