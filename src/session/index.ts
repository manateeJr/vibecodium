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
import type { MachineSessionResolver } from '../machine-sessions/index.js';
import {
  hydrateExternalSession,
  resolveExternalSession,
  type ExternalResumeStorage,
} from './external-session-guard.js';
import type { EventEnvelope, SessionStateReason } from '../contracts/events.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import type { TurnWorkerMessage, WorkerOutputMessage } from '../server/session-worker.js';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateSessionRecord,
  SubstrateSessionState,
} from '../contracts/substrate-contract.js';
import { projectSessionEvent, type SessionSummaryRecord } from './session-summary-projector.js';
import { AdmissionBudget, admissionConfigFromEnv } from './admission.js';
import { PersistentSessionManager } from './persistent-session-manager.js';
import {
  errorMessage,
  forkSession,
  listSessions,
  sessionAttachInfo,
  sessionOpenArgs,
  sessionRenameArgs,
  sessionResumeArgs,
  sessionSendArgs,
  sessionStopArgs,
} from './session-helpers.js';
import type { SessionTable } from './session-table.js';
import { startPersistentSession } from './persistent-session-start.js';
import { createPtySubscription, type PtySubscriptionHub } from './pty-subscriptions.js';
import { requireContext, requireSessionTable } from './session-context.js';
import { stopAllSessions } from './session-shutdown.js';
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
  readonly idleTimeoutMs?: number;
  readonly reaperIntervalMs?: number;
  readonly now?: () => Date;
  readonly machineSessions?: MachineSessionResolver;
}
type SessionRecord = SessionSummaryRecord;
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
  private persistentManager: PersistentSessionManager | undefined;
  private readonly reconciledSubstrateSessions = new Set<string>();
  private readonly machineSessions: MachineSessionResolver | undefined;
  private readonly sessionStorageRoot: string;
  private readonly admission: AdmissionBudget;
  private context: SubsystemContext | undefined;
  public subscribePty!: PtySubscriptionHub['subscribe'];
  private reconciliationPromise: Promise<void> | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly reaperIntervalMs: number | undefined;
  private readonly now: () => Date;
  private reconciliationStarted = false;
  public constructor(options: SessionSubsystemOptions = {}) {
    this.workerPath =
      options.workerPath ?? fileURLToPath(new URL('../server/session-worker.js', import.meta.url));
    this.forkProcess = options.fork ?? nodeFork;
    this.idFactory = options.idFactory ?? randomUUID;
    this.sessionStorageRoot = options.sessionStorageRoot ?? DEFAULT_SESSION_STORAGE_ROOT;
    this.admission = options.admission ?? new AdmissionBudget(admissionConfigFromEnv());
    this.substrate = options.substrate;
    this.sessionTable = options.sessionTable;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.reaperIntervalMs = options.reaperIntervalMs;
    this.machineSessions = options.machineSessions;
    this.now = options.now ?? (() => new Date());
  }
  public register(context: SubsystemContext): void {
    if (this.context) throw new Error('session subsystem is already registered');
    this.context = context;
    this.subscribePty = createPtySubscription(this.substrate, this.sessionTable);
    context.registerPtySource?.(this.subscribePty);
    if (this.substrate) {
      this.persistentManager = new PersistentSessionManager({
        substrate: this.substrate,
        ...(this.sessionTable === undefined ? {} : { sessionTable: this.sessionTable }),
        sessionStorageRoot: this.sessionStorageRoot,
        sessionStorageDirs: this.sessionStorageDirs,
        append: context.append.bind(context),
        summaryFor: (sessionId) => this.sessionRecords.get(sessionId)?.summary,
        onStateChange: (sessionId, state, reason) =>
          this.emitSessionState(sessionId, state, reason),
        now: this.now,
        ...(this.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.idleTimeoutMs }),
        ...(this.reaperIntervalMs === undefined ? {} : { reaperIntervalMs: this.reaperIntervalMs }),
      });
      this.persistentManager.startReaper();
    }
    context.registerProjector('session-summaries', (event) => this.projectEvent(event), 0);
    context.registerCommand(COMMAND_NAMES.sessionOpen, (command: unknown) => this.open(command));
    context.registerCommand(COMMAND_NAMES.sessionResume, (command: unknown) =>
      this.resume(command),
    );
    context.registerCommand(COMMAND_NAMES.sessionRename, (command: unknown) =>
      this.rename(command),
    );
    context.registerCommand(COMMAND_NAMES.sessionSend, (command: unknown) => this.send(command));
    context.registerCommand(COMMAND_NAMES.sessionStop, (command: unknown) => this.stop(command));
    context.registerCommand(COMMAND_NAMES.sessionList, (command: unknown) => this.list(command));
    context.registerCommand(COMMAND_NAMES.sessionFork, (command: unknown) => this.fork(command));
    context.registerCommand(
      COMMAND_NAMES.sessionEnsureLive,
      (command: unknown) =>
        this.persistentManager?.ensureLiveCommand(command) ??
        Promise.reject(new Error('persistent substrate is not configured')),
    );
    context.registerCommand(
      COMMAND_NAMES.sessionSendKeys,
      (command: unknown) =>
        this.persistentManager?.sendKeysCommand(command) ??
        Promise.reject(new Error('persistent substrate is not configured')),
    );
    context.registerCommand(COMMAND_NAMES.sessionAttachInfo, (command: unknown) =>
      sessionAttachInfo(this.sessionTable, command),
    );
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
    const table = requireSessionTable(this.sessionTable);
    const saved = table.upsert(record);
    this.applySubstrateState(record.sessionId, record.state, record.updatedAt);
    return saved;
  }
  public updateSessionState(
    session_id: string,
    state: SubstrateSessionState,
    updatedAt?: string,
  ): SubstrateSessionRecord {
    const table = requireSessionTable(this.sessionTable);
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
    requireContext(this.context).append(stream_id, 'session_state', {
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
    if (this.persistentManager?.supports(record.provider)) {
      try {
        const updated = await this.persistentManager.attach(record);
        this.sessionStorageDirs.set(record.sessionId, updated.storageDir);
      } catch {
        this.reconciledSubstrateSessions.delete(record.sessionId);
        this.emitSessionState(record.sessionId, 'resumable', 'reconciled');
      }
      return;
    }
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
    const external = await resolveExternalSession(this.machineSessions, args.source, args.ref, () =>
      this.now().getTime(),
    );
    const resumeRef = external?.ref ?? args.ref;
    const cwd = args.cwd ?? external?.cwd;
    const result = await this.startSession(
      {
        provider: args.source,
        prompt: args.prompt,
        ...(cwd === undefined ? {} : { cwd }),
        ...(args.project === undefined ? {} : { project: args.project }),
      },
      resumeRef,
      external === undefined
        ? undefined
        : { storageDir: path.dirname(external.path), transcriptPath: external.path },
    );
    if (external)
      hydrateExternalSession(this.sessionRecords, this.sessionTable, result.session_id, external);
    return result;
  }
  public list(command: unknown): SessionListResult {
    return listSessions(this.sessionRecords, command);
  }
  public rename(command: unknown): { label: string } {
    const args = sessionRenameArgs(command);
    const record = this.sessionRecords.get(args.session_id);
    if (!record) throw new Error('session not found');
    const updatedAt = this.now().toISOString();
    if (this.sessionTable?.get(args.session_id) !== undefined) {
      this.sessionTable.rename(args.session_id, args.label, updatedAt);
    }
    record.summary = { ...record.summary, label: args.label, updated_at: updatedAt };
    return { label: args.label };
  }

  public async fork(command: unknown): Promise<SessionForkResult> {
    return forkSession(command, {
      context: requireContext(this.context),
      sessionRecords: this.sessionRecords,
      idFactory: this.idFactory,
      sessionStorageRoot: this.sessionStorageRoot,
      sessionStorageDirs: this.sessionStorageDirs,
      ...(this.machineSessions === undefined ? {} : { machineSessions: this.machineSessions }),
      ...(this.sessionTable === undefined ? {} : { sessionTable: this.sessionTable }),
      now: this.now,
    });
  }

  private startSession(
    args: SessionOpenArgs,
    resumeRef?: string,
    resumeStorage?: ExternalResumeStorage,
  ): Promise<SessionOpenResult> {
    if (this.persistentManager?.supports(args.provider)) {
      const active =
        [...this.sessions.values()].filter((state) => state.terminal === false).length +
        (this.persistentManager.activeCount ?? 0);
      return startPersistentSession({
        args,
        ...(resumeRef === undefined ? {} : { resumeRef }),
        ...(resumeStorage === undefined
          ? {}
          : {
              storageDir: resumeStorage.storageDir,
              transcriptPath: resumeStorage.transcriptPath,
            }),
        active,
        admission: this.admission,
        idFactory: this.idFactory,
        context: requireContext(this.context),
        manager: this.persistentManager,
        onStarted: (sessionId) => this.markSessionLive(sessionId),
      });
    }
    return spawnSession({
      args,
      ...(resumeRef === undefined ? {} : { resumeRef }),
      context: requireContext(this.context),
      active:
        [...this.sessions.values()].filter((state) => state.terminal === false).length +
        (this.persistentManager?.activeCount ?? 0),
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
  public send(command: unknown): SessionSendResult | Promise<SessionSendResult> {
    const args = sessionSendArgs(command);
    if (
      this.persistentManager?.has(args.session_id) ||
      this.sessionTable?.get(args.session_id)?.state === 'resumable'
    ) {
      const turn = this.persistentManager?.send(args.session_id, args.prompt);
      if (turn === undefined) throw new Error('persistent substrate is not configured');
      if (typeof turn === 'number') {
        return { stream_id: `session:${args.session_id}`, turn };
      }
      return turn.then((value) => ({ stream_id: `session:${args.session_id}`, turn: value }));
    }
    const state = this.sessions.get(args.session_id);
    if (!state || state.terminal) throw new Error('session not found');
    if (state.busy) throw new Error('session is busy');
    const turn = ++state.turn;
    requireContext(this.context).append(state.stream_id, 'session_input', {
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
    if (this.persistentManager?.has(args.session_id)) {
      const provider = this.sessionTable?.get(args.session_id)?.provider ?? 'omp';
      requireContext(this.context).append(`session:${args.session_id}`, 'session_complete', {
        session_id: args.session_id,
        provider,
      });
      this.stoppedSessions.add(args.session_id);
      await this.persistentManager.stop(args.session_id);
      if (this.sessionTable?.get(args.session_id) !== undefined) {
        this.sessionTable.updateState(args.session_id, 'closed');
      }
      return { stopped: true };
    }
    const state = this.sessions.get(args.session_id);
    if (!state || state.terminal) return { stopped: false };
    state.terminal = true;
    this.stoppedSessions.add(args.session_id);
    requireContext(this.context).append(state.stream_id, 'session_complete', {
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
    stopAllSessions(
      this.sessionTable,
      this.sessions,
      (sessionId) => this.emitSessionState(sessionId, 'resumable', 'shutdown'),
      () => void this.persistentManager?.shutdown(),
    );
  }
  private handleWorkerMessage(state: SessionState, message: WorkerOutputMessage): void {
    if (state.terminal || !message || message.stream_id !== state.stream_id) return;
    if (message.type === 'event') {
      requireContext(this.context).append(message.stream_id, message.event_type, message.payload);
      if (message.event_type === 'turn_complete') state.busy = false;
      return;
    }
    if (message.type === 'error') this.failSession(state, message.message);
  }
  private failSession(state: SessionState, message: string, terminal = false): void {
    if (state.terminal) return;
    requireContext(this.context).append(state.stream_id, 'verify_failed', {
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
  public reapIdle(): Promise<readonly string[]> {
    return this.persistentManager?.runReaper() ?? Promise.resolve([]);
  }
  private projectEvent(event: EventEnvelope): void {
    projectSessionEvent(event, {
      records: this.sessionRecords,
      ...(this.sessionTable === undefined ? {} : { sessionTable: this.sessionTable }),
      sessionStartStatus: (sessionId) => this.sessionStartStatus(sessionId),
      isLive: (sessionId) =>
        (this.substrate === undefined && this.sessionTable === undefined) ||
        this.sessions.has(sessionId) ||
        this.persistentManager?.has(sessionId) === true ||
        this.reconciledSubstrateSessions.has(sessionId),
    });
  }
  private sessionStartStatus(session_id: string): SessionSummary['status'] {
    if (this.substrate === undefined && this.sessionTable === undefined) return 'live';
    if (this.sessions.has(session_id) || this.persistentManager?.has(session_id) === true)
      return 'live';
    const record = this.sessionTable?.get(session_id);
    return this.reconciledSubstrateSessions.has(session_id) && record?.state === 'live'
      ? 'live'
      : 'stopped';
  }
  private markSessionLive(session_id: string): void {
    this.applySubstrateState(session_id, 'live', this.now().toISOString());
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
}
export function createSessionSubsystem(options: SessionSubsystemOptions = {}): SessionSubsystem {
  return new SessionSubsystem(options);
}
