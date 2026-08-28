import { fork as nodeFork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_NAMES,
  type SessionOpenArgs,
  type SessionOpenResult,
  type SessionStopArgs,
  type SessionStopResult,
} from '../contracts/commands.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import type { StartWorkerMessage, WorkerOutputMessage } from '../server/session-worker.js';

export type SessionFork = (
  modulePath: string,
  args: readonly string[],
  options: ForkOptions,
) => ChildProcess;

export interface SessionSubsystemOptions {
  readonly workerPath?: string;
  readonly fork?: SessionFork;
  readonly idFactory?: () => string;
}

interface SessionState {
  readonly session_id: string;
  readonly stream_id: string;
  readonly worker: ChildProcess;
  terminal: boolean;
}

export class SessionSubsystem implements Subsystem {
  public readonly name = 'session';
  private readonly workerPath: string;
  private readonly forkProcess: SessionFork;
  private readonly idFactory: () => string;
  private readonly sessions = new Map<string, SessionState>();
  private context: SubsystemContext | undefined;
  private registered = false;

  public constructor(options: SessionSubsystemOptions = {}) {
    this.workerPath =
      options.workerPath ?? fileURLToPath(new URL('../server/session-worker.js', import.meta.url));
    this.forkProcess = options.fork ?? nodeFork;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public register(context: SubsystemContext): void {
    if (this.registered) throw new Error('session subsystem is already registered');
    this.registered = true;
    this.context = context;
    context.registerCommand(COMMAND_NAMES.sessionOpen, (command: unknown) => this.open(command));
    context.registerCommand(COMMAND_NAMES.sessionStop, (command: unknown) => this.stop(command));
  }

  public async open(command: unknown): Promise<SessionOpenResult> {
    const args = sessionOpenArgs(command);
    const context = this.requireContext();
    const session_id = this.idFactory();
    if (!session_id.trim()) throw new Error('session id is required');
    const stream_id = `session:${session_id}`;
    context.append(stream_id, 'session_started', {
      session_id,
      provider: args.provider,
      prompt: args.prompt,
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

    const state: SessionState = { session_id, stream_id, worker, terminal: false };
    this.sessions.set(session_id, state);
    worker.on('message', (message: WorkerOutputMessage) =>
      this.handleWorkerMessage(state, message),
    );
    worker.on('error', (error) => this.failSession(state, errorMessage(error)));
    worker.on('exit', (code) => {
      if (code !== 0 && !state.terminal)
        this.failSession(state, `session worker exited with code ${code ?? 'unknown'}`);
      this.sessions.delete(session_id);
    });

    const startMessage: StartWorkerMessage = {
      type: 'start',
      session_id,
      stream_id,
      provider: args.provider,
      prompt: args.prompt,
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

  public async stop(command: unknown): Promise<SessionStopResult> {
    const args = sessionStopArgs(command);
    const state = this.sessions.get(args.session_id);
    if (!state || state.terminal) return { stopped: false };
    state.terminal = true;
    this.sessions.delete(args.session_id);
    if (state.worker.connected || !state.worker.killed) state.worker.kill();
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
    if (!message || message.stream_id !== state.stream_id) return;
    if (message.type === 'event') {
      this.requireContext().append(message.stream_id, message.event_type, message.payload);
      if (message.event_type === 'session_complete') state.terminal = true;
      return;
    }
    if (message.type === 'error') this.failSession(state, message.message);
  }

  private failSession(state: SessionState, message: string): void {
    if (state.terminal) return;
    state.terminal = true;
    this.requireContext().append(state.stream_id, 'verify_failed', {
      session_id: state.session_id,
      stage: 'session',
      error: message,
    });
  }

  private requireContext(): SubsystemContext {
    if (!this.context) throw new Error('session subsystem is not registered');
    return this.context;
  }
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
  return {
    provider: value.provider,
    prompt: value.prompt,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
  };
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
