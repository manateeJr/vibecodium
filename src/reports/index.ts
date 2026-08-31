import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  COMMAND_NAMES,
  type ReportGetArgs,
  type ReportGetResult,
  type ReportListArgs,
  type ReportListResult,
  type ReportPinArgs,
  type ReportPinResult,
  type ReportPromoteArgs,
  type ReportPromoteResult,
  type SessionOpenResult,
  type SessionSendResult,
} from '../contracts/commands.js';
import {
  REPORT_STREAM_ID,
  REPORT_SWEEP_INTERVAL_MS,
  type ReportRecord,
} from '../contracts/report-commands.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { handleReportIntake, type ReportIntakeOptions } from '../server/report-intake.js';
import { ReportStore, type ReportAttachmentInput, type ReportEnvelope } from './store.js';

export interface SessionSubsystemLike {
  open(command: unknown): Promise<SessionOpenResult>;
  send(command: unknown): SessionSendResult | Promise<SessionSendResult>;
}

export interface ReportsSubsystemOptions {
  readonly store?: ReportStore;
  readonly sessions: SessionSubsystemLike;
  readonly sweepIntervalMs?: number;
}

export class ReportsSubsystem implements Subsystem {
  public readonly name = 'reports';
  public readonly store: ReportStore;
  private readonly sessions: SessionSubsystemLike;
  private readonly sweepIntervalMs: number;
  private context: SubsystemContext | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;

  public constructor(options: ReportsSubsystemOptions) {
    this.store = options.store ?? new ReportStore();
    this.sessions = options.sessions;
    this.sweepIntervalMs = options.sweepIntervalMs ?? REPORT_SWEEP_INTERVAL_MS;
    if (!Number.isFinite(this.sweepIntervalMs) || this.sweepIntervalMs <= 0) {
      throw new Error('report sweep interval must be a positive finite number');
    }
  }

  public register(context: SubsystemContext): void {
    if (this.context) throw new Error('reports subsystem is already registered');
    this.context = context;
    context.registerCommand(COMMAND_NAMES.reportList, (command: unknown) => this.list(command));
    context.registerCommand(COMMAND_NAMES.reportGet, (command: unknown) => this.get(command));
    context.registerCommand(COMMAND_NAMES.reportPin, (command: unknown) => this.pin(command));
    context.registerCommand(COMMAND_NAMES.reportDismiss, (command: unknown) =>
      this.dismiss(command),
    );
    context.registerCommand(COMMAND_NAMES.reportPromote, (command: unknown) =>
      this.promote(command),
    );
    this.sweepTimer = setInterval(
      () => void this.sweepNow().catch(() => undefined),
      this.sweepIntervalMs,
    );
    this.sweepTimer.unref();
    void this.sweepNow().catch(() => undefined);
  }

  public intake(
    request: IncomingMessage,
    response: ServerResponse,
    options?: Pick<ReportIntakeOptions, 'verifyToken' | 'maxBytes'>,
  ): Promise<void> {
    return handleReportIntake(request, response, {
      store: this.store,
      ...options,
      onCreated: (record) => this.recordCreated(record),
    });
  }

  public async create(
    envelope: ReportEnvelope,
    attachments: readonly ReportAttachmentInput[] = [],
  ): Promise<ReportRecord> {
    const record = await this.store.create(envelope, attachments);
    this.recordCreated(record);
    return record;
  }

  public stopSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  public sweepNow(): Promise<number> {
    return this.store.sweep();
  }

  private async list(command: unknown): Promise<ReportListResult> {
    const args = reportListArgs(command);
    return { reports: await this.store.list(args.limit) };
  }

  private async get(command: unknown): Promise<ReportGetResult> {
    const args = reportGetArgs(command);
    const result = await this.store.get(args.id);
    return { report: result.report, body: result.body, body_path: result.bodyPath };
  }

  private async pin(command: unknown): Promise<ReportPinResult> {
    const args = reportPinArgs(command);
    const pinned = await this.store.setPinned(args.id, args.pinned);
    if (!pinned) throw new Error('report not found');
    return { pinned: args.pinned };
  }

  private async dismiss(command: unknown): Promise<{ readonly dismissed: boolean }> {
    const args = reportDismissArgs(command);
    return { dismissed: await this.store.dismiss(args.id) };
  }

  private async promote(command: unknown): Promise<ReportPromoteResult> {
    const args = reportPromoteArgs(command);
    const { report } = await this.store.get(args.id);
    const prompt = composePrompt(report, this.store);
    if (args.target === 'new') {
      const result = await this.sessions.open({
        provider: args.provider ?? 'omp',
        prompt,
        origin: 'operator',
        source: 'pocket',
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.project === undefined ? {} : { project: args.project }),
      });
      return { stream_id: result.stream_id, session_id: result.session_id };
    }
    const sessionId = args.session_id;
    if (sessionId === undefined) throw new Error('session_id is required');
    const result = await this.sessions.send({ session_id: sessionId, prompt });
    return { stream_id: result.stream_id, session_id: sessionId };
  }

  private recordCreated(record: ReportRecord): void {
    this.context?.append(REPORT_STREAM_ID, 'report_received', {
      report_id: record.id,
      app: record.app,
      kind: record.kind,
      title: record.title,
      ...(record.summary === undefined ? {} : { summary: record.summary }),
      captured_at: record.capturedAt,
    });
  }
}

export function createReportsSubsystem(options: ReportsSubsystemOptions): ReportsSubsystem {
  return new ReportsSubsystem(options);
}

export function composePrompt(record: ReportRecord, store: ReportStore): string {
  const orientation = [
    `Debug report: ${record.title}`,
    `App: ${record.app} · Kind: ${record.kind} · Captured: ${record.capturedAt}${
      record.device === undefined ? '' : ` · Device: ${record.device}`
    }`,
    ...(record.summary === undefined ? [] : [record.summary]),
    ...(record.note === undefined ? [] : [`Note: ${record.note}`]),
  ].join('\n');
  const attachments = [store.bodyPath(record.id), ...store.attachmentPaths(record)].map(
    (filePath) => `Attached file: ${filePath}`,
  );
  return `${orientation}\n\n${attachments.join('\n')}`;
}

function reportListArgs(command: unknown): ReportListArgs {
  if (command === undefined) return {};
  const value = asRecord(command);
  if (!value) throw new Error('report.list arguments must be an object');
  const limit = value.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0)) {
    throw new Error('limit must be a non-negative integer');
  }
  return limit === undefined ? {} : { limit };
}

function reportGetArgs(command: unknown): ReportGetArgs {
  const value = asRecord(command);
  if (!value || typeof value.id !== 'string' || !value.id.trim()) throw new Error('id is required');
  return { id: value.id };
}

function reportPinArgs(command: unknown): ReportPinArgs {
  const value = asRecord(command);
  if (!value || typeof value.id !== 'string' || !value.id.trim()) throw new Error('id is required');
  if (typeof value.pinned !== 'boolean') throw new Error('pinned must be a boolean');
  return { id: value.id, pinned: value.pinned };
}

function reportDismissArgs(command: unknown): { readonly id: string } {
  const value = asRecord(command);
  if (!value || typeof value.id !== 'string' || !value.id.trim()) throw new Error('id is required');
  return { id: value.id };
}

function reportPromoteArgs(command: unknown): ReportPromoteArgs {
  const value = asRecord(command);
  if (!value || typeof value.id !== 'string' || !value.id.trim()) throw new Error('id is required');
  const target = value.target;
  if (target !== 'new' && target !== 'existing') {
    throw new Error('target must be new or existing');
  }
  const sessionId = typeof value.session_id === 'string' ? value.session_id : undefined;
  if (target === 'existing' && (!sessionId || !sessionId.trim())) {
    throw new Error('session_id is required');
  }
  const optionalStrings = new Map<string, string | undefined>([
    ['provider', typeof value.provider === 'string' ? value.provider : undefined],
    ['cwd', typeof value.cwd === 'string' ? value.cwd : undefined],
    ['project', typeof value.project === 'string' ? value.project : undefined],
  ]);
  for (const [key, optionalValue] of optionalStrings) {
    if (value[key] !== undefined && (!optionalValue || !optionalValue.trim())) {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
  const provider = optionalStrings.get('provider');
  const cwd = optionalStrings.get('cwd');
  const project = optionalStrings.get('project');
  return {
    id: value.id,
    target,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(provider === undefined ? {} : { provider }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(project === undefined ? {} : { project }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
