import { createConnection, type Socket } from 'node:net';
import {
  decodeUint32,
  decodeUint64,
  encodeFrame,
  FrameDecoder,
  MESSAGE_TYPES,
  type AbducoFrame,
} from './protocol.js';

export interface AttachmentEvents {
  onContent?(data: Uint8Array): void;
  onExit?(status: number | undefined): void;
  onClose?(error: Error | undefined): void;
}

export interface AttachmentConnection {
  readonly pid: bigint;
  send(type: number, payload?: Uint8Array): Promise<void>;
  close(sendDetach?: boolean): Promise<void>;
  destroy(): void;
}

function frameStatus(payload: Uint8Array): number | undefined {
  if (payload.length < 4) return undefined;
  return decodeUint32(payload);
}

function writeSocket(socket: Socket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Error('abduco attachment socket is closed'));
      return;
    }
    const onError = (error: Error) => {
      socket.off('close', onClose);
      reject(error);
    };
    const onClose = () => {
      socket.off('error', onError);
      reject(new Error('abduco attachment socket closed during write'));
    };
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(frame, () => {
      socket.off('error', onError);
      socket.off('close', onClose);
      resolve();
    });
  });
}

export function openAttachment(
  socketPath: string,
  events: AttachmentEvents,
): Promise<AttachmentConnection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const decoder = new FrameDecoder();
    let pid: bigint | undefined;
    let exited = false;
    let ready = false;
    let closed = false;
    let closeNotified = false;
    let writeChain = Promise.resolve();
    let attachSent = false;
    let attachFailure: Error | undefined;

    const notifyClose = (error: Error | undefined) => {
      if (closeNotified) return;
      closeNotified = true;
      if (ready) events.onClose?.(error);
    };
    const fail = (error: Error) => {
      if (!ready) reject(error);
      notifyClose(error);
      socket.destroy();
    };
    const enqueue = (frame: Buffer): Promise<void> => {
      const next = writeChain.then(() => writeSocket(socket, frame));
      writeChain = next.catch(() => undefined);
      return next;
    };
    const maybeReady = () => {
      if (ready || pid === undefined || !attachSent || attachFailure !== undefined) return;
      ready = true;
      const connection: AttachmentConnection = {
        pid,
        send: (type, payload = new Uint8Array()) => enqueue(encodeFrame(type, payload)),
        close: async (sendDetach = true) => {
          if (closed) return;
          if (sendDetach && !exited) {
            await enqueue(encodeFrame(MESSAGE_TYPES.detach)).catch(() => undefined);
          }
          socket.destroy();
        },
        destroy: () => socket.destroy(),
      };
      resolve(connection);
    };

    socket.once('connect', () => {
      enqueue(encodeFrame(MESSAGE_TYPES.attach, new Uint8Array(4)))
        .then(() => {
          attachSent = true;
          maybeReady();
        })
        .catch((error: unknown) => {
          attachFailure = error instanceof Error ? error : new Error(String(error));
          fail(attachFailure);
        });
    });
    socket.on('data', (chunk: Buffer) => {
      let frames: AbducoFrame[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const frame of frames) {
        if (frame.type === MESSAGE_TYPES.pid) {
          try {
            pid = decodeUint64(frame.payload);
            maybeReady();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        } else if (frame.type === MESSAGE_TYPES.content) {
          events.onContent?.(frame.payload);
        } else if (frame.type === MESSAGE_TYPES.exit) {
          exited = true;
          events.onExit?.(frameStatus(frame.payload));
        }
      }
    });
    socket.on('error', (error) => {
      if (!ready) fail(error);
    });
    socket.on('close', () => {
      closed = true;
      if (!ready) {
        reject(new Error(`abduco attachment closed before handshake: ${socketPath}`));
        return;
      }
      notifyClose(exited ? undefined : new Error('abduco attachment disconnected'));
    });
  });
}
