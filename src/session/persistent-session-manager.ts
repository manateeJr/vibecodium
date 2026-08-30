import path from 'node:path';
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
import { SessionIdleReaper, type SessionReapCandidate } from './idle-reaper.js';
import { sessionEnsureLiveArgs, sessionSendKeysArgs } from './session-helpers.js';
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
    reason: 'reaped' | 'resumed',
  ) => void;
  readonly now?: () => Date;
  readonly idleTimeoutMs?: number;
  readonly reaperIntervalMs?: number;
}
type PersistentWorkerConfig = Omit<
  ConstructorParameters<typeof PersistentSessionWorker>[0],
  'substrate' | 'append' | 'onActivity'
>;

export interface PersistentSessionEnsureResult {
  readonly state: SubstrateSessionState;
  readonly substrateName: string;
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
      onReaped: (candidate) => this.finishReap(candidate),
      now: () => this.now().getTime(),
      ...(options.idleTimeoutMs === undefined ? {} : { timeoutMs: options.idleTimeoutMs }),
      ...(options.reaperIntervalMs === undefined ? {} : { intervalMs: options.reaperIntervalMs }),
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
  ): Promise<SubstrateSessionRecord> {
    const plugin = this.pluginFor(args.provider);
    const storageDir = path.join(this.sessionStorageRoot, sessionId);
    this.sessionStorageDirs.set(sessionId, storageDir);
    const worker = this.workerFor({
      sessionId,
      streamId,
      provider: args.provider,
      plugin,
      substrateName: substrateNameFor(sessionId),
      storageDir,
      transcriptPath: path.join(storageDir, 'session.jsonl'),
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
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
  public send(sessionId: string, prompt: string): number {
    const worker = this.requireWorker(sessionId);
    if (worker.isBusy) throw new Error('session is busy');
    const turn = worker.currentTurn + 1;
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
    if (record.state === 'live' && this.workers.has(sessionId)) {
      return { state: 'live', substrateName: record.substrateName };
    }
    if (record.state === 'live' && (await this.substrate.isLive(record.substrateName))) {
      const attached = await this.attach(record);
      return { state: 'live', substrateName: attached.substrateName };
    }
    const summary = this.summaryFor(sessionId);
    const plugin = this.pluginFor(record.provider);
    const worker = this.workerFor({
      sessionId,
      streamId: `session:${sessionId}`,
      provider: record.provider,
      plugin,
      substrateName: record.substrateName,
      storageDir: record.storageDir,
      transcriptPath: record.transcriptPath,
      harnessRef: record.harnessRef,
      ...(summary?.cwd === undefined ? {} : { cwd: summary.cwd }),
      startAtEnd: true,
    });
    const started = await worker.start(undefined, record.harnessRef);
    const updated = this.recordFromStart(record.provider, worker, started, 'live', record);
    this.workers.set(sessionId, worker);
    table.upsert(updated);
    this.onStateChange(sessionId, 'live', 'resumed');
    return { state: 'live', substrateName: updated.substrateName };
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
    });
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
    return {
      sessionId: worker.sessionId,
      provider,
      harnessRef: started.harnessRef,
      substrateName: worker.substrateName,
      transcriptPath: started.transcriptPath,
      storageDir: worker.storageDir,
      state,
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
    }));
  }

  private async finishReap(candidate: SessionReapCandidate): Promise<void> {
    const worker = this.workers.get(candidate.sessionId);
    if (!worker) return;
    this.workers.delete(candidate.sessionId);
    await worker.shutdown();
    this.onStateChange(candidate.sessionId, 'resumable', 'reaped');
  }
}

function substrateNameFor(sessionId: string): string {
  return `substrate-${sessionId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
