import type { WebSocket } from 'ws';
import type { PtySubscribeFrame, PtyUnsubscribeFrame } from '../contracts/session-commands.js';

export type PtySource = (sessionId: string, listener: (data: Uint8Array) => void) => () => void;

type SocketSubscriptions = Map<WebSocket, Map<string, () => void>>;
type PtyClientFrame = PtySubscribeFrame | PtyUnsubscribeFrame;

export class PtyBridge {
  private source: PtySource | undefined;

  public constructor(
    private readonly clientSubscriptions: SocketSubscriptions,
    private readonly send: (socket: WebSocket, message: unknown) => void,
  ) {}

  public registerSource(source: PtySource): void {
    this.source = source;
  }

  public handle(socket: WebSocket, message: PtyClientFrame): void {
    if (message.type === 'pty_subscribe') this.subscribe(socket, message);
    else this.unsubscribe(socket, message);
  }

  private subscribe(socket: WebSocket, message: PtySubscribeFrame): void {
    if (!message.session_id.trim()) {
      this.send(socket, {
        type: 'error',
        code: 'invalid_pty_subscription',
        message: 'session_id is required',
      });
      return;
    }
    const subscriptions = this.clientSubscriptions.get(socket);
    if (!subscriptions) return;
    const key = ptySubscriptionKey(message.session_id);
    subscriptions.get(key)?.();
    subscriptions.delete(key);
    if (this.source === undefined) {
      this.send(socket, {
        type: 'error',
        code: 'pty_unavailable',
        message: 'PTY output source is not registered',
      });
      return;
    }
    const unsubscribe = this.source(message.session_id, (data) => {
      this.send(socket, {
        type: 'pty',
        session_id: message.session_id,
        data_b64: Buffer.from(data).toString('base64'),
      });
    });
    subscriptions.set(key, unsubscribe);
  }

  private unsubscribe(socket: WebSocket, message: PtyUnsubscribeFrame): void {
    const subscriptions = this.clientSubscriptions.get(socket);
    if (!subscriptions) return;
    const key = ptySubscriptionKey(message.session_id);
    subscriptions.get(key)?.();
    subscriptions.delete(key);
  }
}

function ptySubscriptionKey(sessionId: string): string {
  return `pty:${sessionId}`;
}
