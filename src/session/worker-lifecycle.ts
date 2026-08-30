import path from 'node:path';
import type { ChildProcess, ForkOptions } from 'node:child_process';
import type { SessionOpenArgs, SessionOpenResult } from '../contracts/commands.js';
import type { SubsystemContext } from '../contracts/subsystem.js';
import type { StartWorkerMessage, WorkerOutputMessage } from '../server/session-worker.js';
import { SessionThrottledError } from './admission.js';
import type { AdmissionBudget } from './admission.js';
import { errorMessage } from './session-helpers.js';

export type SessionFork = (
  modulePath: string,
  args: readonly string[],
  options: ForkOptions,
) => ChildProcess;

export interface SessionState {
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: string;
  readonly worker: ChildProcess;
  turn: number;
  busy: boolean;
  terminal: boolean;
}

export interface StartSessionOptions {
  readonly args: SessionOpenArgs;
  readonly resumeRef?: string;
  readonly context: SubsystemContext;
  readonly active: number;
  readonly admission: AdmissionBudget;
  readonly sessionStorageDirs: Map<string, string>;
  readonly idFactory: () => string;
  readonly workerPath: string;
  readonly forkProcess: SessionFork;
  readonly sessionStorageRoot: string;
  readonly defaultSessionStorageRoot: string;
  readonly sessions: Map<string, SessionState>;
  readonly onSessionStarted: (sessionId: string) => void;
  readonly onWorkerMessage: (state: SessionState, message: WorkerOutputMessage) => void;
  readonly onWorkerError: (state: SessionState, message: string, terminal?: boolean) => void;
}

export async function startSession(options: StartSessionOptions): Promise<SessionOpenResult> {
  const decision = options.admission.tryAdmit(options.active);
  if (!decision.ok) {
    options.context.append(
      'admission',
      'session_throttled' as never,
      {
        provider: options.args.provider,
        reason: decision.reason,
        limit: decision.limit,
        ...(decision.retry_after_ms === undefined
          ? {}
          : { retry_after_ms: decision.retry_after_ms }),
      } as never,
    );
    throw new SessionThrottledError(decision);
  }
  const session_id = options.idFactory();
  if (!session_id.trim()) throw new Error('session id is required');
  const stream_id = `session:${session_id}`;
  const storageDir =
    options.resumeRef === undefined ? path.join(options.sessionStorageRoot, session_id) : undefined;
  if (storageDir !== undefined) options.sessionStorageDirs.set(session_id, storageDir);
  options.context.append(stream_id, 'session_started', {
    session_id,
    provider: options.args.provider,
    prompt: options.args.prompt,
    ...(options.args.cwd === undefined ? {} : { cwd: options.args.cwd }),
    ...(options.args.project === undefined ? {} : { project: options.args.project }),
  });
  let worker: ChildProcess;
  try {
    const forkOptions: ForkOptions = {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      ...(options.args.cwd === undefined ? {} : { cwd: options.args.cwd }),
    };
    worker = options.forkProcess(options.workerPath, [], forkOptions);
  } catch (error: unknown) {
    options.context.append(stream_id, 'verify_failed', {
      session_id,
      stage: 'session',
      error: errorMessage(error),
    });
    throw error;
  }
  const state: SessionState = {
    session_id,
    stream_id,
    provider: options.args.provider,
    worker,
    turn: 1,
    busy: true,
    terminal: false,
  };
  options.sessions.set(session_id, state);
  options.onSessionStarted(session_id);
  worker.on('message', (message: WorkerOutputMessage) => options.onWorkerMessage(state, message));
  worker.on('error', (error) => options.onWorkerError(state, errorMessage(error), true));
  worker.on('exit', (code) => {
    if (code !== 0 && !state.terminal) {
      options.onWorkerError(state, `session worker exited with code ${code ?? 'unknown'}`, true);
    }
    options.sessions.delete(session_id);
  });
  const startMessage: StartWorkerMessage = {
    type: 'start',
    session_id,
    stream_id,
    provider: options.args.provider,
    prompt: options.args.prompt,
    ...(options.args.cwd === undefined ? {} : { cwd: options.args.cwd }),
    ...(options.resumeRef === undefined ? {} : { resumeRef: options.resumeRef }),
    ...(storageDir === undefined || options.sessionStorageRoot === options.defaultSessionStorageRoot
      ? {}
      : { storageDir }),
  };
  try {
    worker.send(startMessage, (error) => {
      if (error) options.onWorkerError(state, errorMessage(error));
    });
  } catch (error: unknown) {
    options.onWorkerError(state, errorMessage(error));
  }
  return { session_id, stream_id };
}
