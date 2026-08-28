import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerByName } from '../provider/provider.js';
import type { ProviderSessionRef } from '../provider/provider.js';

export interface StartWorkerMessage {
  readonly type: 'start';
  readonly sessionId: string;
  readonly streamId: string;
  readonly provider: string;
  readonly prompt: string;
}

export interface WorkerEventMessage {
  readonly type: 'event';
  readonly streamId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

export interface WorkerDoneMessage {
  readonly type: 'done';
  readonly streamId: string;
}

export interface WorkerErrorMessage {
  readonly type: 'error';
  readonly streamId: string;
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
    const session = await provider.spawn({ sessionId: message.sessionId, prompt: message.prompt });
    await send({
      type: 'event',
      streamId: message.streamId,
      eventType: 'provider.started',
      payload: { provider: provider.name, providerSessionId: session.id },
    });
    for await (const chunk of provider.stream(session)) {
      await send({
        type: 'event',
        streamId: message.streamId,
        eventType: 'provider.output',
        payload: { index: chunk.index, text: chunk.text },
      });
    }
    await provider.stop(session);
    await send({
      type: 'event',
      streamId: message.streamId,
      eventType: 'session.completed',
      payload: { provider: provider.name },
    });
  } catch (error) {
    await send({
      type: 'error',
      streamId: message.streamId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await send({ type: 'done', streamId: message.streamId });
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
