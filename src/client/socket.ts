import type { ClientOptions, SocketConstructor, SocketLike } from './types.js';

// Socket plumbing shared by the event subscription and the read-only PTY mirror. Kept free of
// non-type imports so /client.js stays a standalone browser module.

export const OPEN_STATE = 1;

export function socketConstructor(options: ClientOptions): SocketConstructor | undefined {
  const browserWebSocket: unknown = globalThis.WebSocket;
  return (
    options.webSocket ??
    (typeof browserWebSocket === 'function' ? (browserWebSocket as SocketConstructor) : undefined)
  );
}

/** The control plane speaks WebSocket on the same origin: https becomes wss, http becomes ws. */
export function websocketUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`;
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`;
  return baseUrl;
}

/** Browsers expose addEventListener, the ws package exposes on; support both. */
export function addSocketListener(
  socket: SocketLike,
  type: string,
  listener: (event: unknown) => void,
): void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return;
  }
  socket.on?.(type, (...args: unknown[]) => listener(args[0]));
}

export function parseSocketMessage(event: unknown): Record<string, unknown> | undefined {
  const candidate = isRecord(event) && 'data' in event ? event.data : event;
  let serialized: string;
  if (typeof candidate === 'string') serialized = candidate;
  else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(candidate))
    serialized = candidate.toString();
  else if (candidate instanceof ArrayBuffer) serialized = new TextDecoder().decode(candidate);
  else return undefined;
  try {
    const value: unknown = JSON.parse(serialized);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Exponential backoff, capped so a long outage still retries every five seconds. */
export function reconnectDelay(attempt: number): number {
  return Math.min(5_000, 50 * 2 ** Math.min(attempt, 7));
}

/**
 * Decodes base64 to raw bytes. atob yields one code unit per byte, so this stays byte-exact for
 * UTF-8 sequences and ANSI escapes instead of mangling them through a lossy string decode.
 */
export function base64ToBytes(value: string): Uint8Array {
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(value, 'base64'));
  throw new Error('base64 decoding is unavailable');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
