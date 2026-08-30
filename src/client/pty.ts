import {
  OPEN_STATE,
  addSocketListener,
  base64ToBytes,
  parseSocketMessage,
  reconnectDelay,
  socketConstructor,
  websocketUrl,
} from './socket.js';
import type { ClientOptions, PtyListeners, PtyStatus, SocketLike } from './types.js';

/**
 * Subscribes to a session's read-only PTY mirror over the control-plane WebSocket.
 *
 * The subscription is ephemeral: the server replays a ~64KiB ring buffer to a new subscriber and
 * tears the subscription down when the socket closes. Nothing here ever sends input or a terminal
 * size — the mirror is strictly one-way, and phone-side terminal interactivity is a non-goal.
 *
 * Returns a dispose function that unsubscribes and closes the socket.
 */
export function createPtySubscription(
  options: ClientOptions,
  sessionId: string,
  listeners: PtyListeners,
): () => void {
  let cancelled = false;
  let socket: SocketLike | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  const Socket = socketConstructor(options);

  const report = (status: PtyStatus, detail?: string): void => {
    listeners.onStatus?.(status, detail);
  };

  // Off-loopback sockets (the phone) are rejected without the capability token.
  const frame = (type: 'pty_subscribe' | 'pty_unsubscribe'): string =>
    JSON.stringify({
      type,
      session_id: sessionId,
      ...(options.token === undefined ? {} : { token: options.token }),
    });

  const scheduleReconnect = (): void => {
    if (cancelled || reconnectTimer !== undefined || !Socket) return;
    const delay = reconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (cancelled || !Socket) return;
    report('connecting');
    let nextSocket: SocketLike;
    try {
      nextSocket = new Socket(websocketUrl(options.baseUrl));
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error));
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
    // One subscribe per socket: a duplicate would make the server fan out every frame twice.
    let subscribed = false;
    addSocketListener(nextSocket, 'open', () => {
      if (cancelled || socket !== nextSocket || subscribed) return;
      if (nextSocket.readyState !== OPEN_STATE) return;
      subscribed = true;
      reconnectAttempt = 0;
      nextSocket.send(frame('pty_subscribe'));
      // The server replays its ring buffer on subscribe, so the mirror paints immediately.
      report('live');
    });
    addSocketListener(nextSocket, 'message', (event) => {
      if (cancelled || socket !== nextSocket) return;
      const message = parseSocketMessage(event);
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
        listeners.onData(base64ToBytes(message.data_b64));
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error));
      }
    });
    addSocketListener(nextSocket, 'close', () => {
      if (cancelled || socket !== nextSocket) return;
      socket = undefined;
      report('disconnected');
      scheduleReconnect();
    });
  };

  if (Socket) connect();
  else report('unavailable', 'WebSocket is unavailable in this browser');

  return () => {
    if (cancelled) return;
    cancelled = true;
    if (reconnectTimer !== undefined) globalThis.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const currentSocket = socket;
    socket = undefined;
    if (currentSocket?.readyState === OPEN_STATE) currentSocket.send(frame('pty_unsubscribe'));
    currentSocket?.close();
  };
}
