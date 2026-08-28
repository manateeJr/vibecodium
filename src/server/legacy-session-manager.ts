import { fork as nodeFork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { EventKind, EventPayload } from '../contracts/events.js';
import type { StartWorkerMessage, WorkerOutputMessage } from './session-worker.js';
import type { Authority } from './authority.js';

export interface LegacySessionOpenMessage {
  readonly provider: string;
  readonly prompt: string;
}

export type EventAppender = (stream_id: string, type: EventKind, payload: EventPayload) => number;

interface SessionState {
  readonly sessionId: string;
  readonly streamId: string;
  readonly worker: ChildProcess;
  terminal: boolean;
}

export interface LegacySessionManagerOptions {
  readonly authority: Authority;
  readonly appendEvent: EventAppender;
  readonly workerPath?: string;
  readonly fork?: (
    modulePath: string,
    args: readonly string[],
    options: ForkOptions,
  ) => ChildProcess;
}

export class LegacySessionManager {
  private readonly authority: Authority;
  private readonly appendEvent: EventAppender;
  private readonly workerPath: string;
  private readonly forkProcess: NonNullable<LegacySessionManagerOptions['fork']>;
  private readonly sessions = new Map<string, SessionState>();

  public constructor(options: LegacySessionManagerOptions) {
    this.authority = options.authority;
    this.appendEvent = options.appendEvent;
    this.workerPath =
      options.workerPath ?? fileURLToPath(new URL('./session-worker.js', import.meta.url));
    this.forkProcess = options.fork ?? nodeFork;
  }

  public async open(
    message: LegacySessionOpenMessage,
    send: (message: unknown) => void,
  ): Promise<void> {
    if (!message.provider || typeof message.prompt !== 'string') {
      send({
        type: 'error',
        code: 'invalid_session',
        message: 'provider and prompt are required',
      });
      return;
    }
    const decision = this.authority.evaluate({
      type: 'session.open',
      scope: { provider: message.provider },
    });
    if (!decision.allowed) {
      send({ type: 'action.result', allowed: false, reason: decision.reason });
      return;
    }
    const sessionId = randomUUID();
    const streamId = `session:${sessionId}`;
    const openedSeq = this.appendEvent(streamId, 'session_started', {
      session_id: sessionId,
      provider: message.provider,
      prompt: message.prompt,
    });
    const worker = this.forkProcess(this.workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const state: SessionState = { sessionId, streamId, worker, terminal: false };
    this.sessions.set(sessionId, state);
    worker.on('message', (workerMessage: WorkerOutputMessage) =>
      this.handleWorkerMessage(state, workerMessage),
    );
    worker.on('error', (error) => this.failSession(state, errorMessage(error)));
    worker.on('exit', (code) => {
      if (code !== 0 && !state.terminal)
        this.failSession(state, `session worker exited with code ${code ?? 'unknown'}`);
      this.sessions.delete(sessionId);
    });
    send({
      type: 'session.opened',
      sessionId,
      streamId,
      cursor: openedSeq,
    });
    const startMessage: StartWorkerMessage = {
      type: 'start',
      session_id: sessionId,
      stream_id: streamId,
      provider: message.provider,
      prompt: message.prompt,
    };
    worker.send(startMessage, (error) => {
      if (error) this.failSession(state, errorMessage(error));
    });
  }

  public stop(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.terminal) return false;
    session.terminal = true;
    session.worker.kill();
    return true;
  }

  public stopAll(): void {
    for (const session of this.sessions.values()) {
      session.terminal = true;
      if (session.worker.connected) session.worker.kill();
    }
    this.sessions.clear();
  }

  private handleWorkerMessage(state: SessionState, message: WorkerOutputMessage): void {
    if (!message || message.stream_id !== state.streamId) return;
    if (message.type === 'event') {
      this.appendEvent(message.stream_id, message.event_type, message.payload);
      if (message.event_type === 'session_complete') state.terminal = true;
      return;
    }
    if (message.type === 'error') this.failSession(state, message.message);
  }

  private failSession(state: SessionState, message: string): void {
    if (state.terminal) return;
    state.terminal = true;
    this.appendEvent(state.streamId, 'verify_failed', {
      session_id: state.sessionId,
      stage: 'session',
      error: message,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
