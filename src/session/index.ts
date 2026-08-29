import { cp, mkdir, stat } from 'node:fs/promises';
import { fork as nodeFork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_NAMES,
  type SessionForkResult,
  type SessionListResult,
  type SessionOpenArgs,
  type SessionOpenResult,
  type SessionResumeArgs,
  type SessionResumeResult,
  type SessionSendArgs,
  type SessionSendResult,
  type SessionStopArgs,
  type SessionStopResult,
  type SessionSummary,
} from '../contracts/commands.js';
import type { EventEnvelope } from '../contracts/events.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import type {
  StartWorkerMessage,
  TurnWorkerMessage,
  WorkerOutputMessage,
} from '../server/session-worker.js';
import { AdmissionBudget, admissionConfigFromEnv, SessionThrottledError } from './admission.js';
const DEFAULT_SESSION_STORAGE_ROOT = path.join(os.tmpdir(), 'vibecodium-sessions');
export type SessionFork = (
  modulePath: string,
  args: readonly string[],
  options: ForkOptions,
) => ChildProcess;
export interface SessionSubsystemOptions {
  readonly workerPath?: string;
  readonly fork?: SessionFork;
  readonly idFactory?: () => string;
  readonly admission?: AdmissionBudget;
  readonly sessionStorageRoot?: string;
}
interface SessionState {
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: string;
  readonly worker: ChildProcess;
  turn: number;
  busy: boolean;
  terminal: boolean;
}
type SessionRecord = { summary: SessionSummary; readonly startedSeq: number };
export class SessionSubsystem implements Subsystem {
  public readonly name = 'session';
  private readonly workerPath: string;
  private readonly forkProcess: SessionFork;
  private readonly idFactory: () => string;
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionRecords = new Map<string, SessionRecord>();
  private readonly sessionStorageDirs = new Map<string, string>();
  private readonly stoppedSessions = new Set<string>();
  private readonly sessionStorageRoot: string;
  private readonly admission: AdmissionBudget;
  private context: SubsystemContext | undefined;
  private registered = false;
  public constructor(options: SessionSubsystemOptions = {}) {
    this.workerPath =
      options.workerPath ?? fileURLToPath(new URL('../server/session-worker.js', import.meta.url));
    this.forkProcess = options.fork ?? nodeFork;
    this.idFactory = options.idFactory ?? randomUUID;
    this.sessionStorageRoot = options.sessionStorageRoot ?? DEFAULT_SESSION_STORAGE_ROOT;
    this.admission = options.admission ?? new AdmissionBudget(admissionConfigFromEnv());
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
    const value = command === undefined ? {} : asRecord(command);
    if (!value) throw new Error('session.list command must be an object');
    const project = value.project;
    if (project !== undefined && (typeof project !== 'string' || !project.trim())) {
      throw new Error('project must be a non-empty string');
    }
    const limitValue = value.limit;
    if (limitValue !== undefined && (!Number.isInteger(limitValue) || (limitValue as number) < 0)) {
      throw new Error('limit must be a non-negative integer');
    }
    const limit = (limitValue as number | undefined) ?? 10;
    const sessions = [...this.sessionRecords.values()]
      .filter((record) => project === undefined || record.summary.project === project)
      .sort((left, right) => {
        const leftStarted = left.summary.started_at
          ? Date.parse(left.summary.started_at)
          : Number.NaN;
        const rightStarted = right.summary.started_at
          ? Date.parse(right.summary.started_at)
          : Number.NaN;
        const leftTimestamp = Number.isFinite(leftStarted) ? leftStarted : 0;
        const rightTimestamp = Number.isFinite(rightStarted) ? rightStarted : 0;
        return rightTimestamp - leftTimestamp || right.startedSeq - left.startedSeq;
      })
      .slice(0, limit)
      .map((record) => record.summary);
    return { sessions };
  }
  public async fork(command: unknown): Promise<SessionForkResult> {
    const value = asRecord(command);
    if (!value || typeof value.session_id !== 'string' || !value.session_id.trim()) {
      throw new Error('session_id is required');
    }
    const session_id = value.session_id;
    const source = this.sessionRecords.get(session_id);
    if (!source) throw new Error('session not found');
    const new_session_id = this.idFactory();
    if (
      !new_session_id.trim() ||
      new_session_id === session_id ||
      new_session_id.includes('/') ||
      new_session_id.includes('\\') ||
      this.sessionRecords.has(new_session_id)
    ) {
      throw new Error('forked session id is invalid or already exists');
    }
    const sourcePath = await this.sessionStorePath(session_id);
    const targetStorageDir = path.join(this.sessionStorageRoot, new_session_id);
    await copySessionStore(sourcePath, targetStorageDir);
    this.sessionStorageDirs.set(new_session_id, targetStorageDir);
    const stream_id = `session:${new_session_id}`;
    const prompt = source.summary.prompt ?? '';
    this.requireContext().append(stream_id, 'session_started', {
      session_id: new_session_id,
      provider: source.summary.provider,
      prompt,
      ...(source.summary.cwd === undefined ? {} : { cwd: source.summary.cwd }),
      ...(source.summary.project === undefined ? {} : { project: source.summary.project }),
    });
    this.requireContext().append(stream_id, 'session_forked', {
      session_id: new_session_id,
      source_session_id: session_id,
      provider: source.summary.provider,
    });
    return {
      new_session_id,
      provider: source.summary.provider,
      continue_command: continueCommand(source.summary.provider, new_session_id, targetStorageDir),
    };
  }
  private async startSession(
    args: SessionOpenArgs,
    resumeRef?: string,
  ): Promise<SessionOpenResult> {
    const context = this.requireContext();
    const active = [...this.sessions.values()].filter((state) => state.terminal === false).length;
    const decision = this.admission.tryAdmit(active);
    if (!decision.ok) {
      context.append(
        'admission',
        'session_throttled' as never,
        {
          provider: args.provider,
          reason: decision.reason,
          limit: decision.limit,
          ...(decision.retry_after_ms === undefined
            ? {}
            : { retry_after_ms: decision.retry_after_ms }),
        } as never,
      );
      throw new SessionThrottledError(decision);
    }
    const session_id = this.idFactory();
    if (!session_id.trim()) throw new Error('session id is required');
    const stream_id = `session:${session_id}`;
    const storageDir =
      resumeRef === undefined ? path.join(this.sessionStorageRoot, session_id) : undefined;
    if (storageDir !== undefined) this.sessionStorageDirs.set(session_id, storageDir);
    context.append(stream_id, 'session_started', {
      session_id,
      provider: args.provider,
      prompt: args.prompt,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.project === undefined ? {} : { project: args.project }),
    });
    let worker: ChildProcess;
    try {
      const options: ForkOptions = {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      };
      worker = this.forkProcess(this.workerPath, [], options);
    } catch (error: unknown) {
      context.append(stream_id, 'verify_failed', {
        session_id,
        stage: 'session',
        error: errorMessage(error),
      });
      throw error;
    }
    const state: SessionState = {
      session_id,
      stream_id,
      provider: args.provider,
      worker,
      turn: 1,
      busy: true,
      terminal: false,
    };
    this.sessions.set(session_id, state);
    worker.on('message', (message: WorkerOutputMessage) =>
      this.handleWorkerMessage(state, message),
    );
    worker.on('error', (error) => this.failSession(state, errorMessage(error), true));
    worker.on('exit', (code) => {
      if (code !== 0 && !state.terminal) {
        this.failSession(state, `session worker exited with code ${code ?? 'unknown'}`, true);
      }
      this.sessions.delete(session_id);
    });
    const startMessage: StartWorkerMessage = {
      type: 'start',
      session_id,
      stream_id,
      provider: args.provider,
      prompt: args.prompt,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(resumeRef === undefined ? {} : { resumeRef }),
      ...(storageDir === undefined || this.sessionStorageRoot === DEFAULT_SESSION_STORAGE_ROOT
        ? {}
        : { storageDir }),
    };
    try {
      worker.send(startMessage, (error) => {
        if (error) this.failSession(state, errorMessage(error));
      });
    } catch (error: unknown) {
      this.failSession(state, errorMessage(error));
    }
    return { session_id, stream_id };
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
          status: 'live',
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
    const status =
      eventType === 'verify_failed'
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
  private async sessionStorePath(session_id: string): Promise<string> {
    const knownPath = this.sessionStorageDirs.get(session_id);
    const candidates = [
      knownPath,
      path.join(this.sessionStorageRoot, session_id),
      path.join(this.sessionStorageRoot, `${session_id}.jsonl`),
    ].filter((candidate): candidate is string => candidate !== undefined);
    for (const candidate of candidates) {
      try {
        await stat(candidate);
        return candidate;
      } catch {
        // Try the next provider storage shape.
      }
    }
    throw new Error(`session store not found for ${session_id}`);
  }
  private requireContext(): SubsystemContext {
    if (!this.context) throw new Error('session subsystem is not registered');
    return this.context;
  }
}
async function copySessionStore(sourcePath: string, targetStorageDir: string): Promise<void> {
  let sourceStats;
  try {
    sourceStats = await stat(sourcePath);
  } catch {
    throw new Error(`session store not found at ${sourcePath}`);
  }
  if (sourceStats.isDirectory()) {
    await cp(sourcePath, targetStorageDir, { recursive: true, force: false, errorOnExist: true });
    return;
  }
  await mkdir(targetStorageDir);
  await cp(sourcePath, path.join(targetStorageDir, path.basename(sourcePath)), {
    force: false,
    errorOnExist: true,
  });
}
function continueCommand(provider: string, session_id: string, storageDir: string): string {
  const quotedStorageDir = /^[A-Za-z0-9_./:-]+$/.test(storageDir)
    ? storageDir
    : `'${storageDir.replaceAll("'", "'\\''")}'`;
  if (provider === 'omp' || provider === 'claude') {
    return `${provider} --resume ${session_id} --session-dir ${quotedStorageDir}`;
  }
  if (provider === 'codex') return `codex resume ${session_id}`;
  return `${provider} --resume ${session_id} --session-dir ${quotedStorageDir}`;
}
export function createSessionSubsystem(options: SessionSubsystemOptions = {}): SessionSubsystem {
  return new SessionSubsystem(options);
}
function sessionOpenArgs(command: unknown): SessionOpenArgs {
  const value = asRecord(command);
  if (!value || typeof value.provider !== 'string' || !value.provider.trim())
    throw new Error('provider is required');
  if (typeof value.prompt !== 'string') throw new Error('prompt is required');
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd.trim()))
    throw new Error('cwd must be a non-empty string');
  if (value.project !== undefined && (typeof value.project !== 'string' || !value.project.trim()))
    throw new Error('project must be a non-empty string');
  return {
    provider: value.provider,
    prompt: value.prompt,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.project === undefined ? {} : { project: value.project }),
  };
}
function sessionResumeArgs(command: unknown): SessionResumeArgs {
  const value = asRecord(command);
  if (!value || (value.source !== 'omp' && value.source !== 'codex'))
    throw new Error('source must be omp or codex');
  if (typeof value.ref !== 'string' || !value.ref.trim()) throw new Error('ref is required');
  if (typeof value.prompt !== 'string') throw new Error('prompt is required');
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd.trim()))
    throw new Error('cwd must be a non-empty string');
  if (value.project !== undefined && (typeof value.project !== 'string' || !value.project.trim()))
    throw new Error('project must be a non-empty string');
  return {
    source: value.source,
    ref: value.ref,
    prompt: value.prompt,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.project === undefined ? {} : { project: value.project }),
  };
}
function sessionSendArgs(command: unknown): SessionSendArgs {
  const value = asRecord(command);
  if (!value || typeof value.session_id !== 'string' || !value.session_id.trim())
    throw new Error('session_id is required');
  if (typeof value.prompt !== 'string') throw new Error('prompt is required');
  return { session_id: value.session_id, prompt: value.prompt };
}
function sessionStopArgs(command: unknown): SessionStopArgs {
  const value = asRecord(command);
  if (!value || typeof value.session_id !== 'string' || !value.session_id.trim())
    throw new Error('session_id is required');
  return { session_id: value.session_id };
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
