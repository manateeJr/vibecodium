import { randomUUID } from 'node:crypto';
import { fork as nodeFork } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_NAMES,
  type SessionForkResult,
  type SessionListResult,
  type SessionOpenArgs,
  type SessionOpenResult,
  type SessionResumeResult,
  type SessionSendResult,
  type SessionStopResult,
  type SessionSummary,
} from '../contracts/commands.js';
import type { EventEnvelope, SessionStateReason } from '../contracts/events.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import type { TurnWorkerMessage, WorkerOutputMessage } from '../server/session-worker.js';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateSessionRecord,
  SubstrateSessionState,
} from '../contracts/substrate-contract.js';
import { AdmissionBudget, admissionConfigFromEnv } from './admission.js';
import {
  asRecord,
  errorMessage,
  forkSession,
  listSessions,
  sessionOpenArgs,
  sessionResumeArgs,
  sessionSendArgs,
  sessionStopArgs,
} from './session-helpers.js';
import type { SessionTable } from './session-table.js';

import { startSession as spawnSession } from './worker-lifecycle.js';
import type { SessionFork, SessionState } from './worker-lifecycle.js';
export type { SessionFork } from './worker-lifecycle.js';
const DEFAULT_SESSION_STORAGE_ROOT = path.join(os.tmpdir(), 'vibecodium-sessions');
export interface SessionSubsystemOptions {
  readonly workerPath?: string;
  readonly fork?: SessionFork;
  readonly idFactory?: () => string;
  readonly admission?: AdmissionBudget;
  readonly sessionStorageRoot?: string;
  readonly substrate?: SubstrateClient;
  readonly sessionTable?: SessionTable;
}
type SessionRecord = { summary: SessionSummary; readonly startedSeq: number };
export class SessionSubsystem implements Subsystem {
  public readonly name = 'session';
  public readonly substrate: SubstrateClient | undefined;
  public readonly sessionTable: SessionTable | undefined;
  private readonly workerPath: string;
  private readonly forkProcess: SessionFork;
  private readonly idFactory: () => string;
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionRecords = new Map<string, SessionRecord>();
  private readonly sessionStorageDirs = new Map<string, string>();
  private readonly stoppedSessions = new Set<string>();
  private readonly substrateAttachments = new Map<string, SubstrateAttachment>();
  private readonly reconciledSubstrateSessions = new Set<string>();
  private readonly sessionStorageRoot: string;
  private readonly admission: AdmissionBudget;
  private context: SubsystemContext | undefined;
  private reconciliationPromise: Promise<void> | undefined;
  private reconciliationStarted = false;
  private registered = false;
  public constructor(options: SessionSubsystemOptions = {}) {
    this.workerPath =
      options.workerPath ?? fileURLToPath(new URL('../server/session-worker.js', import.meta.url));
    this.forkProcess = options.fork ?? nodeFork;
    this.idFactory = options.idFactory ?? randomUUID;
    this.sessionStorageRoot = options.sessionStorageRoot ?? DEFAULT_SESSION_STORAGE_ROOT;
    this.admission = options.admission ?? new AdmissionBudget(admissionConfigFromEnv());
    this.substrate = options.substrate;
    this.sessionTable = options.sessionTable;
  }
  public register(context: SubsystemContext): void {
    if (this.registered) throw new Error('session subsystem is already registered');
    this.registered = true;
    this.context = context;
    context.registerProjector('session-summaries', (event) => this.projectEvent(event), 0);
    context.registerCommand(COMMAND_NAMES.sessionOpen, (command: unknown) => this.open(command));
    context.registerCommand(COMMAND_NAMES.sessionResume, (command: unknown) =>
      this.resume(command),
    );
    context.registerCommand(COMMAND_NAMES.sessionSend, (command: unknown) => this.send(command));
    context.registerCommand(COMMAND_NAMES.sessionStop, (command: unknown) => this.stop(command));
    context.registerCommand(COMMAND_NAMES.sessionList, (command: unknown) => this.list(command));
    context.registerCommand(COMMAND_NAMES.sessionFork, (command: unknown) => this.fork(command));
    void this.reconcile().catch(() => undefined);
  }
  public reconcile(): Promise<void> {
    if (!this.substrate || !this.sessionTable) return Promise.resolve();
    if (this.reconciliationStarted) return this.reconciliationPromise ?? Promise.resolve();
    this.reconciliationStarted = true;
    this.reconciliationPromise = this.reconcileRecords();
    return this.reconciliationPromise;
  }
  public saveSessionRecord(record: SubstrateSessionRecord): SubstrateSessionRecord {
    const table = this.requireSessionTable();
    const saved = table.upsert(record);
    this.applySubstrateState(record.sessionId, record.state, record.updatedAt);
    return saved;
  }
  public updateSessionState(
    session_id: string,
    state: SubstrateSessionState,
    updatedAt?: string,
  ): SubstrateSessionRecord {
    const table = this.requireSessionTable();
    const record =
      updatedAt === undefined
        ? table.updateState(session_id, state)
        : table.updateState(session_id, state, updatedAt);
    this.applySubstrateState(session_id, state, record.updatedAt);
    return record;
  }
  public emitSessionState(
    session_id: string,
    state: SubstrateSessionState,
    reason: SessionStateReason,
  ): void {
    const current = this.sessionRecords.get(session_id);
    const stream_id = current?.summary.stream_id ?? `session:${session_id}`;
    this.requireContext().append(stream_id, 'session_state', {
      session_id,
      state,
      reason,
    });
    if (this.sessionTable?.get(session_id) !== undefined) {
      this.updateSessionState(session_id, state);
    }
  }
  private async reconcileRecords(): Promise<void> {
    const substrate = this.substrate;
    const table = this.sessionTable;
    if (!substrate || !table) return;
    for (const record of table.list()) {
      if (record.state === 'closed') continue;
      await this.reconcileRecord(record, substrate);
    }
  }
  private async reconcileRecord(
    record: SubstrateSessionRecord,
    substrate: SubstrateClient,
  ): Promise<void> {
    let live = false;
    try {
      live = await substrate.isLive(record.substrateName);
    } catch {
      live = false;
    }
    if (!live) {
      this.reconciledSubstrateSessions.delete(record.sessionId);
      this.emitSessionState(record.sessionId, 'resumable', 'reconciled');
      return;
    }
    this.reconciledSubstrateSessions.add(record.sessionId);
    this.emitSessionState(record.sessionId, 'live', 'reconciled');
    try {
      const attachment = await substrate.attach(record.substrateName);
      this.substrateAttachments.set(record.sessionId, attachment);
    } catch {
      this.reconciledSubstrateSessions.delete(record.sessionId);
      this.emitSessionState(record.sessionId, 'resumable', 'reconciled');
    }
  }
  public async open(command: unknown): Promise<SessionOpenResult> {
    return this.startSession(sessionOpenArgs(command));
  }
  public async resume(command: unknown): Promise<SessionResumeResult> {
    const args = sessionResumeArgs(command);
    return this.startSession(
      {
        provider: args.source,
        prompt: args.prompt,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.project === undefined ? {} : { project: args.project }),
      },
      args.ref,
    );
  }
  public list(command: unknown): SessionListResult {
    return listSessions(this.sessionRecords, command);
  }
  public async fork(command: unknown): Promise<SessionForkResult> {
    return forkSession(command, {
      context: this.requireContext(),
      sessionRecords: this.sessionRecords,
      idFactory: this.idFactory,
      sessionStorageRoot: this.sessionStorageRoot,
      sessionStorageDirs: this.sessionStorageDirs,
    });
  }
  private startSession(args: SessionOpenArgs, resumeRef?: string): Promise<SessionOpenResult> {
    return spawnSession({
      args,
      ...(resumeRef === undefined ? {} : { resumeRef }),
      context: this.requireContext(),
      active: [...this.sessions.values()].filter((state) => state.terminal === false).length,
      admission: this.admission,
      sessionStorageDirs: this.sessionStorageDirs,
      idFactory: this.idFactory,
      workerPath: this.workerPath,
      forkProcess: this.forkProcess,
      sessionStorageRoot: this.sessionStorageRoot,
      defaultSessionStorageRoot: DEFAULT_SESSION_STORAGE_ROOT,
      sessions: this.sessions,
      onSessionStarted: (session_id) => this.markSessionLive(session_id),
      onWorkerMessage: (state, message) => this.handleWorkerMessage(state, message),
      onWorkerError: (state, message, terminal) => this.failSession(state, message, terminal),
    });
  }
  public send(command: unknown): SessionSendResult {
    const args = sessionSendArgs(command);
    const state = this.sessions.get(args.session_id);
    if (!state || state.terminal) throw new Error('session not found');
    if (state.busy) throw new Error('session is busy');
    const turn = ++state.turn;
    this.requireContext().append(state.stream_id, 'session_input', {
      session_id: state.session_id,
      turn,
      text: args.prompt,
    });
    state.busy = true;
    const message: TurnWorkerMessage = {
      type: 'turn',
      stream_id: state.stream_id,
      prompt: args.prompt,
    };
    try {
      state.worker.send(message, (error) => {
        if (error) this.failSession(state, errorMessage(error));
      });
    } catch (error: unknown) {
      this.failSession(state, errorMessage(error));
    }
    return { stream_id: state.stream_id, turn };
  }
  public async stop(command: unknown): Promise<SessionStopResult> {
    const args = sessionStopArgs(command);
    const state = this.sessions.get(args.session_id);
    if (!state || state.terminal) return { stopped: false };
    state.terminal = true;
    this.stoppedSessions.add(args.session_id);
    this.requireContext().append(state.stream_id, 'session_complete', {
      session_id: state.session_id,
      provider: state.provider,
    });
    try {
      state.worker.send({ type: 'stop', stream_id: state.stream_id });
    } catch {
      // Stopping is best effort; the terminal event is already durable.
    }
    if (state.worker.connected || !state.worker.killed) state.worker.kill();
    this.sessions.delete(args.session_id);
    return { stopped: true };
  }
  public stopAll(): void {
    for (const state of this.sessions.values()) {
      const substrateRecord = this.sessionTable?.get(state.session_id);
      if (substrateRecord && substrateRecord.state !== 'closed') {
        this.emitSessionState(state.session_id, 'resumable', 'shutdown');
        state.terminal = true;
        continue;
      }
      state.terminal = true;
      if (state.worker.connected || !state.worker.killed) state.worker.kill();
    }
    this.sessions.clear();
  }
  private handleWorkerMessage(state: SessionState, message: WorkerOutputMessage): void {
    if (state.terminal || !message || message.stream_id !== state.stream_id) return;
    if (message.type === 'event') {
      this.requireContext().append(message.stream_id, message.event_type, message.payload);
      if (message.event_type === 'turn_complete') state.busy = false;
      return;
    }
    if (message.type === 'error') this.failSession(state, message.message);
  }
  private failSession(state: SessionState, message: string, terminal = false): void {
    if (state.terminal) return;
    this.requireContext().append(state.stream_id, 'verify_failed', {
      session_id: state.session_id,
      stage: 'session',
      error: message,
    });
    state.busy = false;
    if (terminal) {
      state.terminal = true;
      this.sessions.delete(state.session_id);
    }
  }
  private projectEvent(event: EventEnvelope): void {
    const payload = asRecord(event.payload);
    const eventType = event.type as string;
    const payloadSessionId = payload?.session_id;
    const session_id =
      typeof payloadSessionId === 'string' && payloadSessionId.trim()
        ? payloadSessionId
        : event.stream_id.startsWith('session:')
          ? event.stream_id.slice('session:'.length)
          : undefined;
    if (eventType === 'session_started') {
      const provider = payload?.provider;
      const prompt = payload?.prompt;
      if (
        !session_id ||
        typeof provider !== 'string' ||
        !provider.trim() ||
        typeof prompt !== 'string'
      ) {
        return;
      }
      this.sessionRecords.set(session_id, {
        startedSeq: event.seq,
        summary: {
          session_id,
          stream_id: event.stream_id,
          provider,
          status: this.sessionStartStatus(session_id),
          prompt,
          started_at: event.ts,
          updated_at: event.ts,
          ...(typeof payload?.project === 'string' ? { project: payload.project } : {}),
          ...(typeof payload?.cwd === 'string' ? { cwd: payload.cwd } : {}),
        },
      });
      return;
    }
    if (!session_id) return;
    const record = this.sessionRecords.get(session_id);
    if (!record) return;
    const substrateStateEvent =
      eventType === 'session_state' &&
      (payload?.state === 'live' || payload?.state === 'resumable' || payload?.state === 'closed');
    const stateIsLive =
      payload?.state === 'live' &&
      ((this.substrate === undefined && this.sessionTable === undefined) ||
        this.sessions.has(session_id) ||
        this.reconciledSubstrateSessions.has(session_id));
    const status = substrateStateEvent
      ? stateIsLive
        ? 'live'
        : 'stopped'
      : eventType === 'verify_failed'
        ? 'failed'
        : eventType === 'session_complete'
          ? this.stoppedSessions.has(session_id)
            ? 'stopped'
            : 'done'
          : eventType === 'session_stop'
            ? 'stopped'
            : undefined;
    record.summary = {
      ...record.summary,
      updated_at: event.ts,
      ...(status === undefined ? {} : { status }),
    };
  }
  private sessionStartStatus(session_id: string): SessionSummary['status'] {
    if (this.substrate === undefined && this.sessionTable === undefined) return 'live';
    if (this.sessions.has(session_id)) return 'live';
    const record = this.sessionTable?.get(session_id);
    return this.reconciledSubstrateSessions.has(session_id) && record?.state === 'live'
      ? 'live'
      : 'stopped';
  }
  private markSessionLive(session_id: string): void {
    this.applySubstrateState(session_id, 'live', new Date().toISOString());
  }
  private applySubstrateState(
    session_id: string,
    state: SubstrateSessionState,
    updatedAt: string,
  ): void {
    const record = this.sessionRecords.get(session_id);
    if (!record) return;
    record.summary = {
      ...record.summary,
      status: state === 'live' ? 'live' : 'stopped',
      updated_at: updatedAt,
    };
  }
  private requireSessionTable(): SessionTable {
    if (!this.sessionTable) throw new Error('session table is not configured');
    return this.sessionTable;
  }
  private requireContext(): SubsystemContext {
    if (!this.context) throw new Error('session subsystem is not registered');
    return this.context;
  }
}
export function createSessionSubsystem(options: SessionSubsystemOptions = {}): SessionSubsystem {
  return new SessionSubsystem(options);
}
