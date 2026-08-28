import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventKind, EventPayload } from '../contracts/events.js';
import { providerByName } from '../provider/provider.js';
import type { ProviderSessionRef } from '../contracts/provider-contract.js';

export interface StartWorkerMessage {
  readonly type: 'start';
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: string;
  readonly prompt: string;
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

export type WorkerMessage = StartWorkerMessage;
export type WorkerOutputMessage = WorkerEventMessage | WorkerDoneMessage | WorkerErrorMessage;

function send(message: WorkerOutputMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('session worker IPC is unavailable'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function runSession(message: StartWorkerMessage): Promise<void> {
  let provider: ProviderSessionRef;
  try {
    provider = providerByName(message.provider);
    const session = await provider.spawn({ sessionId: message.session_id, prompt: message.prompt });
    for await (const chunk of provider.stream(session)) {
      await send({
        type: 'event',
        stream_id: message.stream_id,
        event_type: 'session_output',
        payload: {
          session_id: message.session_id,
          index: chunk.index,
          text: chunk.text,
        },
      });
    }
    await provider.stop(session);
    await send({
      type: 'event',
      stream_id: message.stream_id,
      event_type: 'session_complete',
      payload: { session_id: message.session_id, provider: provider.name },
    });
  } catch (error) {
    await send({
      type: 'error',
      stream_id: message.stream_id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await send({ type: 'done', stream_id: message.stream_id });
  }
}

export function startSessionWorker(): void {
  process.on('message', (message: WorkerMessage) => {
    if (!message || message.type !== 'start') return;
    void runSession(message).then(() => {
      if (process.connected) process.disconnect();
    });
  });
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntryPoint) startSessionWorker();
