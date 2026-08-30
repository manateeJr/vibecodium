import { base64ToBytes } from './base64.js';

// Read-only PTY mirror transport. Lives in web/ rather than the compiled SDK so that /client.js
// stays a single standalone browser module and the control plane needs no extra routes.

const OPEN_STATE = 1;
const MAX_BACKOFF_MS = 5_000;

/** The control plane speaks WebSocket on the same origin: https becomes wss, http becomes ws. */
function websocketUrl(baseUrl) {
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`;
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`;
  return baseUrl;
}

function parseFrame(event) {
  try {
    const value = JSON.parse(typeof event?.data === 'string' ? event.data : '');
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Subscribes to one session's PTY mirror and streams raw bytes to `onData`.
 *
 * Strictly one-way: this never sends input and never sends a terminal size. The server keeps the
 * subscription ephemeral, replays a ~64KiB ring buffer to each new subscriber, and tears the
 * subscription down when the socket closes.
 *
 * `onStatus` receives 'connecting' | 'live' | 'disconnected' | 'unavailable' | 'error'.
 * Returns a dispose function that unsubscribes and closes the socket.
 */
export function createPtySubscription({
  baseUrl,
  token,
  sessionId,
  onData,
  onStatus,
  webSocket = globalThis.WebSocket,
}) {
  let cancelled = false;
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;

  const report = (status, detail) => onStatus?.(status, detail);

  // Off-loopback sockets (the phone) are rejected without the capability token.
  const frame = (type) =>
    JSON.stringify({ type, session_id: sessionId, ...(token ? { token } : {}) });

  const scheduleReconnect = () => {
    if (cancelled || reconnectTimer !== null) return;
    const delay = Math.min(MAX_BACKOFF_MS, 50 * 2 ** Math.min(reconnectAttempt, 7));
    reconnectAttempt += 1;
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (cancelled) return;
    report('connecting');
    let next;
    try {
      next = new webSocket(websocketUrl(baseUrl));
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error));
      scheduleReconnect();
      return;
    }
    socket = next;
    // One subscribe per socket: a duplicate would make the server fan out every frame twice.
    let subscribed = false;
    next.addEventListener('open', () => {
      if (cancelled || socket !== next || subscribed || next.readyState !== OPEN_STATE) return;
      subscribed = true;
      reconnectAttempt = 0;
      next.send(frame('pty_subscribe'));
      // The server replays its ring buffer on subscribe, so the mirror paints immediately.
      report('live');
    });
    next.addEventListener('message', (event) => {
      if (cancelled || socket !== next) return;
      const message = parseFrame(event);
      if (!message) return;
      if (message.type === 'error') {
        if (typeof message.message === 'string') report('error', message.message);
        return;
      }
      if (message.type !== 'pty' || message.session_id !== sessionId) return;
      if (typeof message.data_b64 !== 'string') {
        report('error', 'control plane returned an invalid PTY frame');
        return;
      }
      try {
        onData(base64ToBytes(message.data_b64));
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error));
      }
    });
    next.addEventListener('close', () => {
      if (cancelled || socket !== next) return;
      socket = null;
      report('disconnected');
      scheduleReconnect();
    });
  };

  if (typeof webSocket === 'function') connect();
  else report('unavailable', 'WebSocket is unavailable in this browser');

  return () => {
    if (cancelled) return;
    cancelled = true;
    if (reconnectTimer !== null) globalThis.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const current = socket;
    socket = null;
    if (current?.readyState === OPEN_STATE) current.send(frame('pty_unsubscribe'));
    current?.close();
  };
}
