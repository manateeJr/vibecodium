import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventKind, EventPayload } from '../contracts/events.js';
import type { ProviderSession, ProviderSessionRef } from '../contracts/provider-contract.js';
import { providerByName } from '../provider/provider.js';

export interface StartWorkerMessage {
  readonly type: 'start';
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly resumeRef?: string;
}

export interface TurnWorkerMessage {
  readonly type: 'turn';
  readonly stream_id: string;
  readonly prompt: string;
}

export interface StopWorkerMessage {
  readonly type: 'stop';
  readonly stream_id: string;
}

export interface WorkerEventMessage {
  readonly type: 'event';
  readonly stream_id: string;
  readonly event_type: EventKind;
  readonly payload: EventPayload;
}

export interface WorkerDoneMessage {
  readonly type: 'done';
  readonly stream_id: string;
}

export interface WorkerErrorMessage {
  readonly type: 'error';
  readonly stream_id: string;
  readonly message: string;
}

export type WorkerMessage = StartWorkerMessage | TurnWorkerMessage | StopWorkerMessage;
export type WorkerOutputMessage = WorkerEventMessage | WorkerDoneMessage | WorkerErrorMessage;

interface ConversationState {
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: ProviderSessionRef;
  readonly cwd?: string;
  readonly storageDir?: string;
  turn: number;
  currentSession: ProviderSession | undefined;
  stopping: boolean;
  turnChain: Promise<void>;
  stopPromise: Promise<void> | undefined;
}

function send(message: WorkerOutputMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('session worker IPC is unavailable'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function runTurn(
  state: ConversationState,
  prompt: string,
  resume: boolean,
  turn: number,
  resumeRef?: string,
): Promise<void> {
  let session: ProviderSession | undefined;
  try {
    session = await state.provider.spawn({
      sessionId: state.session_id,
      prompt,
      ...(state.cwd === undefined ? {} : { cwd: state.cwd }),
      ...(state.storageDir === undefined ? {} : { storageDir: state.storageDir }),
      resume,
      ...(resumeRef === undefined ? {} : { resumeRef }),
    });
    state.currentSession = session;
    if (state.stopping) {
      await state.provider.stop(session);
      return;
    }
    for await (const chunk of state.provider.stream(session)) {
      await send({
        type: 'event',
        stream_id: state.stream_id,
        event_type: 'session_output',
        payload: {
          session_id: state.session_id,
          index: chunk.index,
          text: chunk.text,
        },
      });
    }
    await state.provider.stop(session);
    if (state.stopping) return;
    await send({
      type: 'event',
      stream_id: state.stream_id,
      event_type: 'turn_complete',
      payload: { session_id: state.session_id, turn },
    });
  } catch (error) {
    if (session && !session.stopped) {
      try {
        await state.provider.stop(session);
      } catch {
        // Preserve the original turn failure.
      }
    }
    if (state.stopping) return;
    try {
      await send({
        type: 'error',
        stream_id: state.stream_id,
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The parent may have stopped and disconnected while the turn failed.
    }
  } finally {
    if (state.currentSession === session) state.currentSession = undefined;
  }
}

export function startSessionWorker(): void {
  let state: ConversationState | undefined;
  process.on('message', (message: WorkerMessage) => {
    if (!message) return;
    if (message.type === 'start') {
      if (state) return;
      let provider: ProviderSessionRef;
      try {
        provider = providerByName(message.provider);
      } catch (error) {
        void send({
          type: 'error',
          stream_id: message.stream_id,
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        return;
      }
      const storageDir =
        message.resumeRef === undefined
          ? path.join(os.tmpdir(), 'vibecodium-sessions', message.session_id)
          : undefined;
      state = {
        session_id: message.session_id,
        stream_id: message.stream_id,
        provider,
        ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
        ...(storageDir === undefined ? {} : { storageDir }),
        turn: 1,
        stopping: false,
        turnChain: Promise.resolve(),
        currentSession: undefined,
        stopPromise: undefined,
      };
      state.turnChain = (
        storageDir === undefined ? Promise.resolve() : mkdir(storageDir, { recursive: true })
      )
        .then(() => runTurn(state!, message.prompt, false, 1, message.resumeRef))
        .catch(async (error: unknown) => {
          if (state?.stopping) return;
          try {
            await send({
              type: 'error',
              stream_id: message.stream_id,
              message: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // The parent may have stopped and disconnected while starting.
          }
        });
      return;
    }
    if (!state) return;
    if (message.type === 'turn') {
      if (state.stopping) return;
      const turn = ++state.turn;
      state.turnChain = state.turnChain.then(() => runTurn(state!, message.prompt, true, turn));
      return;
    }
    if (state.stopping || state.stopPromise) return;
    state.stopping = true;
    const currentSession = state.currentSession;
    state.stopPromise = (async () => {
      if (currentSession) {
        try {
          await state!.provider.stop(currentSession);
        } catch {
          // Stopping is best effort; the parent owns the terminal event.
        }
      }
      await state!.turnChain.catch(() => undefined);
      try {
        await send({ type: 'done', stream_id: message.stream_id });
      } catch {
        // The parent has already disconnected.
      }
      if (process.connected) process.disconnect();
    })();
  });
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntryPoint) startSessionWorker();
