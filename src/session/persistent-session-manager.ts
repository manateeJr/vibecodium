import path from 'node:path';
import type { SessionStateReason } from '../contracts/events.js';
import type {
  SessionEnsureLiveResult,
  SessionOpenArgs,
  SessionSendKeysResult,
  SessionSummary,
} from '../contracts/commands.js';
import type { SubsystemContext } from '../contracts/subsystem.js';
import type {
  SubstrateClient,
  SubstrateKey,
  SubstrateSessionRecord,
  SubstrateSessionState,
} from '../contracts/substrate-contract.js';
import { providerByName } from '../provider/provider.js';
import {
  PersistentSessionWorker,
  type PersistentSessionStartResult,
} from '../server/session-worker.js';
import {
  SessionIdleReaper,
  type SessionReapCandidate,
  type SessionReapReason,
} from './idle-reaper.js';
import { sessionEnsureLiveArgs, sessionSendKeysArgs } from './session-helpers.js';
import { isSubstrateSessionLive } from './relaunch-liveness.js';
import { harnessRefFromTranscriptPath } from './transcript-ref.js';
import type { SessionTable } from './session-table.js';

export interface PersistentSessionManagerOptions {
  readonly substrate: SubstrateClient;
  readonly sessionTable?: SessionTable;
  readonly sessionStorageRoot: string;
  readonly sessionStorageDirs: Map<string, string>;
  readonly append: SubsystemContext['append'];
  readonly summaryFor: (sessionId: string) => SessionSummary | undefined;
  readonly onStateChange: (
    sessionId: string,
    state: SubstrateSessionState,
    reason: SessionStateReason,
  ) => void;
  readonly now?: () => Date;
  readonly idleTimeoutMs?: number;
  readonly reaperIntervalMs?: number;
  readonly memoryPressureMinMb?: number;
  readonly memoryAvailableMb?: () => number | Promise<number | undefined>;
}
type PersistentWorkerConfig = Omit<
  ConstructorParameters<typeof PersistentSessionWorker>[0],
  'substrate' | 'append' | 'onActivity' | 'onSessionExit'
>;

export interface PersistentSessionEnsureResult {
  readonly state: SubstrateSessionState;
  readonly substrateName: string;
}

interface PersistentSessionRelaunchResult extends PersistentSessionEnsureResult {
  readonly turn?: number;
}

export class PersistentSessionManager {
  private readonly substrate: SubstrateClient;
  private readonly sessionTable: SessionTable | undefined;
  private readonly sessionStorageRoot: string;
  private readonly sessionStorageDirs: Map<string, string>;
  private readonly append: SubsystemContext['append'];
  private readonly summaryFor: (sessionId: string) => SessionSummary | undefined;
  private readonly onStateChange: PersistentSessionManagerOptions['onStateChange'];
  private readonly now: () => Date;
  private readonly workers = new Map<string, PersistentSessionWorker>();
  private readonly relaunches = new Map<string, Promise<PersistentSessionRelaunchResult>>();
  private readonly sessionExitTasks = new Map<string, Promise<void>>();
  private readonly reaper: SessionIdleReaper;

  public constructor(options: PersistentSessionManagerOptions) {
    this.substrate = options.substrate;
    this.sessionTable = options.sessionTable;
    this.sessionStorageRoot = options.sessionStorageRoot;
    this.sessionStorageDirs = options.sessionStorageDirs;
    this.append = options.append;
    this.summaryFor = options.summaryFor;
    this.onStateChange = options.onStateChange;
    this.now = options.now ?? (() => new Date());
    this.reaper = new SessionIdleReaper({
      substrate: this.substrate,
      candidates: () => this.reapCandidates(),
      onReaped: (candidate, reason) => this.finishReap(candidate, reason),
      now: () => this.now().getTime(),
      ...(options.idleTimeoutMs === undefined ? {} : { timeoutMs: options.idleTimeoutMs }),
      ...(options.reaperIntervalMs === undefined ? {} : { intervalMs: options.reaperIntervalMs }),
      ...(options.memoryPressureMinMb === undefined
        ? {}
        : { memoryPressureMinMb: options.memoryPressureMinMb }),
      ...(options.memoryAvailableMb === undefined
        ? {}
        : { memoryAvailableMb: options.memoryAvailableMb }),
    });
  }

  public supports(provider: string): boolean {
    try {
      const adapter = providerByName(provider);
      return adapter.persistent === true && adapter.harnessPlugin !== undefined;
    } catch {
      return false;
    }
  }

  public start(
    args: SessionOpenArgs,
    sessionId: string,
    streamId: string,
    resumeRef?: string,
    storageDirOverride?: string,
    transcriptPathOverride?: string,
  ): Promise<SubstrateSessionRecord> {
    const plugin = this.pluginFor(args.provider);
    const storageDir = storageDirOverride ?? path.join(this.sessionStorageRoot, sessionId);
    const transcriptPath = transcriptPathOverride ?? path.join(storageDir, 'session.jsonl');
    this.sessionStorageDirs.set(sessionId, storageDir);
    const worker = this.workerFor({
      sessionId,
      streamId,
      provider: args.provider,
      plugin,
      substrateName: substrateNameFor(sessionId),
      storageDir,
      transcriptPath,
      ...(resumeRef === undefined ? {} : { harnessRef: resumeRef }),
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.model === undefined ? {} : { model: args.model }),
    });
    return worker.start(args.prompt, resumeRef).then((started) => {
      const record = this.recordFromStart(args.provider, worker, started, 'live');
      this.workers.set(sessionId, worker);
      try {
        this.sessionTable?.upsert(record);
      } catch (error) {
        this.workers.delete(sessionId);
        return worker.stop().then(() => {
          throw error;
        });
      }
      return record;
    });
  }

  public attach(record: SubstrateSessionRecord): Promise<SubstrateSessionRecord> {
    const summary = this.summaryFor(record.sessionId);
    const plugin = this.pluginFor(record.provider);
    const worker = this.workerFor({
      sessionId: record.sessionId,
      streamId: `session:${record.sessionId}`,
      provider: record.provider,
      plugin,
      substrateName: record.substrateName,
      storageDir: record.storageDir,
      transcriptPath: record.transcriptPath,
      harnessRef: record.harnessRef,
      ...(summary?.cwd === undefined ? {} : { cwd: summary.cwd }),
      startAtEnd: true,
    });
    return worker.attachExisting().then((started) => {
      const updated = this.recordFromStart(record.provider, worker, started, 'live', record);
      this.workers.set(record.sessionId, worker);
      if (
        updated.transcriptPath !== record.transcriptPath ||
        updated.harnessRef !== record.harnessRef
      ) {
        this.sessionTable?.upsert(updated);
      }
      return updated;
    });
  }
  public send(sessionId: string, prompt: string): number | Promise<number> {
    const worker = this.workers.get(sessionId);
    if (!worker) {
      const record = this.sessionTable?.get(sessionId);
      if (!record || record.state !== 'resumable') throw new Error('session not found');
      if (this.relaunches.has(sessionId)) throw new Error('session is busy');
      return this.relaunch(record, prompt).then((result) => {
        if (result.turn === undefined) throw new Error('session relaunch did not schedule prompt');
        return result.turn;
      });
    }
    const turn = worker.isBusy ? worker.currentTurn : worker.currentTurn + 1;
    void worker.sendPrompt(prompt).catch((error: unknown) => {
      this.append(`session:${sessionId}`, 'verify_failed', {
        session_id: sessionId,
        stage: 'session',
        error: errorMessage(error),
      });
    });
    return turn;
  }
  public sendKeys(sessionId: string, keys: readonly SubstrateKey[]): Promise<number> {
    return this.requireWorker(sessionId).sendKeys(keys);
  }
  public async ensureLiveCommand(command: unknown): Promise<SessionEnsureLiveResult> {
    const args = sessionEnsureLiveArgs(command);
    const result = await this.ensureLive(args.session_id);
    return { state: result.state, substrate_name: result.substrateName };
  }
  public async sendKeysCommand(command: unknown): Promise<SessionSendKeysResult> {
    const args = sessionSendKeysArgs(command);
    const sent = await this.sendKeys(args.session_id, args.keys);
    return { sent };
  }
  public async stop(sessionId: string): Promise<void> {
    const worker = this.workers.get(sessionId);
    if (!worker) return;
    this.workers.delete(sessionId);
    await worker.stop();
  }
  public async ensureLive(sessionId: string): Promise<PersistentSessionEnsureResult> {
    const table = this.sessionTable;
    if (!table) throw new Error('session table is not configured');
    const record = table.get(sessionId);
    if (!record) throw new Error('session not found');
    if (record.state === 'closed') throw new Error('session is closed');
    const relaunch = this.relaunches.get(sessionId);
    if (relaunch) return relaunch;
    if (
      record.state === 'live' &&
      (await isSubstrateSessionLive(this.substrate, record.substrateName))
    ) {
      if (this.workers.has(sessionId))
        return { state: 'live', substrateName: record.substrateName };
      const attached = await this.attach(record);
      return { state: 'live', substrateName: attached.substrateName };
    }
    if (record.state === 'live') {
      const staleWorker = this.workers.get(sessionId);
      this.workers.delete(sessionId);
      if (staleWorker) await staleWorker.cleanupAfterHarnessExit();
      else await this.substrate.kill(record.substrateName).catch(() => undefined);
      const resumable: SubstrateSessionRecord = {
        ...record,
        state: 'resumable',
        updatedAt: this.now().toISOString(),
      };
      table.upsert(resumable);
      this.onStateChange(sessionId, 'resumable', 'harness-exit');
      return this.relaunch(resumable);
    }
    return this.relaunch(record);
  }
  public async runReaper(): Promise<readonly string[]> {
    await this.flush();
    return this.reaper.runOnce();
  }
  public async flush(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.flushTranscript()));
  }
  public startReaper(): void {
    this.reaper.start();
  }
  public async shutdown(): Promise<void> {
    this.reaper.stop();
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(workers.map((worker) => worker.shutdown()));
  }
  public get activeCount(): number {
    return this.workers.size;
  }
  public has(sessionId: string): boolean {
    return this.workers.has(sessionId);
  }
  private workerFor(options: PersistentWorkerConfig): PersistentSessionWorker {
    return new PersistentSessionWorker({
      ...options,
      substrate: this.substrate,
      append: this.append,
      now: () => this.now().getTime(),
      onActivity: () => this.persistWorkerTranscript(options.sessionId),
      onSessionExit: () => {
        if (this.sessionExitTasks.has(options.sessionId)) return;
        const task = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
          this.handleSessionExit(options.sessionId),
        );
        this.sessionExitTasks.set(options.sessionId, task);
        void task.finally(() => {
          if (this.sessionExitTasks.get(options.sessionId) === task)
            this.sessionExitTasks.delete(options.sessionId);
        });
      },
    });
  }

  private persistWorkerTranscript(sessionId: string): void {
    const worker = this.workers.get(sessionId);
    const record = this.sessionTable?.get(sessionId);
    if (!worker || !record) return;
    const transcriptPath = worker.currentTranscriptPath;
    const harnessRef = harnessRefFromTranscriptPath(transcriptPath) ?? worker.currentHarnessRef;
    if (record.transcriptPath === transcriptPath && record.harnessRef === harnessRef) return;
    this.sessionTable?.upsert({
      ...record,
      harnessRef,
      transcriptPath,
      updatedAt: this.now().toISOString(),
    });
  }
  private async handleSessionExit(sessionId: string): Promise<void> {
    const worker = this.workers.get(sessionId);
    const record = this.sessionTable?.get(sessionId);
    if (!record || record.state !== 'live') return;
    this.workers.delete(sessionId);
    this.sessionTable?.upsert({
      ...record,
      state: 'resumable',
      updatedAt: this.now().toISOString(),
    });
    this.onStateChange(sessionId, 'resumable', 'harness-exit');
    if (worker) await worker.cleanupAfterHarnessExit();
    else await this.substrate.kill(record.substrateName).catch(() => undefined);
  }
  private relaunch(
    record: SubstrateSessionRecord,
    prompt?: string,
  ): Promise<PersistentSessionRelaunchResult> {
    const existing = this.relaunches.get(record.sessionId);
    if (existing) return existing;
    const task = this.startResumable(record, prompt);
    this.relaunches.set(record.sessionId, task);
    void task.then(
      () => this.clearRelaunch(record.sessionId, task),
      () => this.clearRelaunch(record.sessionId, task),
    );
    return task;
  }

  private clearRelaunch(sessionId: string, task: Promise<PersistentSessionRelaunchResult>): void {
    if (this.relaunches.get(sessionId) === task) this.relaunches.delete(sessionId);
  }

  private async startResumable(
    record: SubstrateSessionRecord,
    prompt?: string,
  ): Promise<PersistentSessionRelaunchResult> {
    const summary = this.summaryFor(record.sessionId);
    const plugin = this.pluginFor(record.provider);
    const worker = this.workerFor({
      sessionId: record.sessionId,
      streamId: `session:${record.sessionId}`,
      provider: record.provider,
      plugin,
      substrateName: record.substrateName,
      storageDir: record.storageDir,
      transcriptPath: record.transcriptPath,
      harnessRef: record.harnessRef,
      ...(summary?.cwd === undefined ? {} : { cwd: summary.cwd }),
      startAtEnd: true,
    });
    const turn = prompt === undefined ? undefined : worker.currentTurn + 1;
    try {
      const started = await worker.start(prompt, record.harnessRef);
      const liveness = await worker.verifyRelaunchLiveness();
      if (!liveness.live) {
        await worker.stop().catch(() => undefined);
        this.persistRelaunchFailure(record, worker, liveness.detail, prompt);
        throw new Error(resumeFailureMessage(liveness.detail, prompt));
      }
      const updated = this.recordFromStart(record.provider, worker, started, 'live', record);
      this.workers.set(record.sessionId, worker);
      try {
        this.sessionTable?.upsert(updated);
      } catch (error) {
        this.workers.delete(record.sessionId);
        await worker.stop();
        throw error;
      }
      this.onStateChange(record.sessionId, 'live', 'resumed');
      return {
        state: 'live',
        substrateName: updated.substrateName,
        ...(turn === undefined ? {} : { turn }),
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('resume-failed:')) throw error;
      await worker.stop().catch(() => undefined);
      this.persistRelaunchFailure(record, worker, errorMessage(error), prompt);
      throw new Error(resumeFailureMessage(errorMessage(error), prompt));
    }
  }

  private persistRelaunchFailure(
    record: SubstrateSessionRecord,
    worker: PersistentSessionWorker,
    detail: string,
    prompt: string | undefined,
  ): void {
    const transcriptPath = worker.currentTranscriptPath;
    const harnessRef = harnessRefFromTranscriptPath(transcriptPath) ?? worker.currentHarnessRef;
    const updated: SubstrateSessionRecord = {
      ...record,
      harnessRef,
      transcriptPath,
      state: 'resumable',
      updatedAt: this.now().toISOString(),
    };
    this.sessionTable?.upsert(updated);
    const error = resumeFailureMessage(detail, prompt);
    this.append(`session:${record.sessionId}`, 'verify_failed', {
      session_id: record.sessionId,
      stage: 'session',
      error,
      ...(prompt === undefined ? {} : { prompt }),
    });
    this.onStateChange(record.sessionId, 'resumable', `resume-failed: ${detail}`);
  }

  private pluginFor(provider: string) {
    const adapter = providerByName(provider);
    if (!adapter.persistent || !adapter.harnessPlugin) {
      throw new Error(`provider does not support persistent sessions: ${provider}`);
    }
    return adapter.harnessPlugin;
  }

  private recordFromStart(
    provider: string,
    worker: PersistentSessionWorker,
    started: PersistentSessionStartResult,
    state: SubstrateSessionState,
    previous?: SubstrateSessionRecord,
  ): SubstrateSessionRecord {
    const summary = this.summaryFor(worker.sessionId);
    return {
      sessionId: worker.sessionId,
      provider,
      harnessRef: harnessRefFromTranscriptPath(started.transcriptPath) ?? started.harnessRef,
      substrateName: worker.substrateName,
      transcriptPath: started.transcriptPath,
      storageDir: worker.storageDir,
      state,
      label: previous?.label ?? summary?.label ?? '',
      origin: previous?.origin ?? summary?.origin ?? 'agent',
      updatedAt: previous?.updatedAt ?? this.now().toISOString(),
    };
  }

  private requireWorker(sessionId: string): PersistentSessionWorker {
    const worker = this.workers.get(sessionId);
    if (!worker) throw new Error('session not found');
    return worker;
  }

  private reapCandidates(): readonly SessionReapCandidate[] {
    return [...this.workers.values()].map((worker) => ({
      sessionId: worker.sessionId,
      substrateName: worker.substrateName,
      idle: worker.isIdle,
      lastActivityAt: worker.lastActivityAt,
      runningTurn: worker.isBusy,
    }));
  }

  private async finishReap(
    candidate: SessionReapCandidate,
    reason: SessionReapReason = 'reaped',
  ): Promise<void> {
    const worker = this.workers.get(candidate.sessionId);
    if (!worker) return;
    this.workers.delete(candidate.sessionId);
    await worker.flushTranscript();
    const record = this.sessionTable?.get(candidate.sessionId);
    if (record) {
      const transcriptPath = worker.currentTranscriptPath;
      const harnessRef = harnessRefFromTranscriptPath(transcriptPath) ?? worker.currentHarnessRef;
      this.sessionTable?.upsert({
        ...record,
        harnessRef,
        transcriptPath,
        state: 'resumable',
        updatedAt: this.now().toISOString(),
      });
    }
    await worker.shutdown();
    this.onStateChange(candidate.sessionId, 'resumable', reason);
  }
}

function resumeFailureMessage(detail: string, prompt: string | undefined): string {
  return prompt === undefined
    ? `resume-failed: ${detail}`
    : `resume-failed: ${detail}; undelivered prompt: ${prompt}`;
}

function substrateNameFor(sessionId: string): string {
  return `substrate-${sessionId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
