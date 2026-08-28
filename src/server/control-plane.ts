import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import type { EventEnvelope, EventKind, EventPayload } from '../contracts/events.js';
import type {
  CommandHandler,
  EventHandler,
  Subsystem,
  SubsystemContext,
} from '../contracts/subsystem.js';
import { registerSubsystems } from '../subsystems/index.js';
import { Authority } from './authority.js';
import type { ScopedAction } from './authority.js';
import { EventStore } from './event-store.js';
import type { StartWorkerMessage, WorkerOutputMessage } from './session-worker.js';

export interface ControlPlaneOptions {
  readonly dataPath: string;
  readonly host?: string;
  readonly port?: number;
  readonly authority?: Authority;
  readonly subsystems?: readonly Subsystem[];
}

export interface ControlPlaneAddress {
  readonly host: string;
  readonly port: number;
  readonly httpUrl: string;
  readonly wsUrl: string;
}

export type ClientMessage =
  | {
      readonly type: 'session.open';
      readonly provider: string;
      readonly prompt: string;
    }
  | {
      readonly type: 'subscribe';
      readonly streamId: string;
      readonly fromSeq?: number;
    }
  | {
      readonly type: 'action.request';
      readonly requestId?: string;
      readonly action: ScopedAction;
    };

interface SessionState {
  readonly sessionId: string;
  readonly streamId: string;
  readonly worker: ChildProcess;
  terminal: boolean;
}

export class ControlPlane {
  public readonly eventStore: EventStore;
  public readonly authority: Authority;
  public readonly context: SubsystemContext = {
    registerProjector: (name, onEvent) => this.register(this.projectors, name, onEvent),
    registerCommand: (name, handler) => this.register(this.commands, name, handler),
    registerListener: (name, handler) => this.register(this.listeners, name, handler),
    append: (stream_id, type, payload) => this.appendEvent(stream_id, type, payload),
    subscribe: (stream_id, from_seq, onEvent) =>
      this.eventStore.subscribe(stream_id, from_seq, onEvent),
  };
  private readonly host: string;
  private readonly port: number;
  private readonly workerPath = fileURLToPath(new URL('./session-worker.js', import.meta.url));
  private readonly sessions = new Map<string, SessionState>();
  private readonly projectors = new Map<string, EventHandler>();
  private readonly commands = new Map<string, CommandHandler>();
  private readonly listeners = new Map<string, EventHandler>();
  private readonly clientSubscriptions = new Map<WebSocket, Map<string, () => void>>();
  private httpServer: Server | undefined;
  private websocketServer: WebSocketServer | undefined;
  private boundAddress: ControlPlaneAddress | undefined;

  public constructor(options: ControlPlaneOptions) {
    if (options.dataPath !== ':memory:')
      fs.mkdirSync(path.dirname(options.dataPath), { recursive: true });
    this.eventStore = new EventStore({ filename: options.dataPath });
    this.authority =
      options.authority ??
      new Authority({
        permitted: [
          { type: 'session.open', scope: { provider: '*' } },
          { type: 'session.stop', scope: { session_id: '*' } },
        ],
      });
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 4310;
    if (this.host !== '127.0.0.1' && this.host !== 'localhost' && this.host !== '::1') {
      throw new Error('control plane must bind to localhost');
    }
    registerSubsystems(this.context, options.subsystems);
  }

  public async start(): Promise<ControlPlaneAddress> {
    if (this.boundAddress) return this.boundAddress;
    this.httpServer = createServer((request, response) => this.handleHttp(request, response));
    this.websocketServer = new WebSocketServer({ server: this.httpServer });
    this.websocketServer.on('connection', (socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.httpServer;
      if (!server) return reject(new Error('HTTP server was not created'));
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const serverAddress = this.httpServer.address() as AddressInfo;
    this.boundAddress = {
      host: this.host,
      port: serverAddress.port,
      httpUrl: `http://${this.host}:${serverAddress.port}`,
      wsUrl: `ws://${this.host}:${serverAddress.port}`,
    };
    return this.boundAddress;
  }

  public async stop(): Promise<void> {
    for (const [socket, subscriptions] of this.clientSubscriptions) {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      socket.close();
    }
    this.clientSubscriptions.clear();
    for (const session of this.sessions.values()) {
      if (session.worker.connected) session.worker.kill();
    }
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      if (!this.websocketServer) return resolve();
      this.websocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      try {
        this.httpServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
    this.websocketServer = undefined;
    this.httpServer = undefined;
    this.boundAddress = undefined;
    this.eventStore.close();
  }

  private register<T>(registry: Map<string, T>, name: string, handler: T): void {
    if (!name.trim()) throw new Error('subsystem registration name is required');
    if (registry.has(name)) throw new Error(`duplicate subsystem registration: ${name}`);
    registry.set(name, handler);
  }

  private appendEvent(stream_id: string, type: EventKind, payload: EventPayload): number {
    const seq = this.eventStore.append(stream_id, type, payload);
    const event: EventEnvelope | undefined = this.eventStore
      .read(stream_id, seq - 1)
      .find((candidate) => candidate.seq === seq);
    if (!event) throw new Error(`appended event ${stream_id}:${seq} could not be read`);
    for (const projector of this.projectors.values()) projector(event);
    for (const listener of this.listeners.values()) listener(event);
    return seq;
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      this.sendJson(response, 200, { ok: true, service: 'vibecodium-control-plane' });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/events') {
      const stream_id = requestUrl.searchParams.get('stream_id');
      const from_seq = Number(requestUrl.searchParams.get('from_seq') ?? '0');
      if (!stream_id || !Number.isInteger(from_seq) || from_seq < 0) {
        this.sendJson(response, 400, {
          error: 'stream_id and non-negative integer from_seq are required',
        });
        return;
      }
      this.sendJson(response, 200, { events: this.eventStore.read(stream_id, from_seq) });
      return;
    }
    this.sendJson(response, 404, { error: 'not_found' });
  }

  private handleConnection(socket: WebSocket): void {
    this.clientSubscriptions.set(socket, new Map());
    socket.on('message', (data) => {
      void this.handleClientMessage(socket, data.toString()).catch((error: unknown) => {
        this.send(socket, { type: 'error', code: 'internal_error', message: errorMessage(error) });
      });
    });
    socket.on('close', () => this.cleanupClient(socket));
    socket.on('error', () => this.cleanupClient(socket));
  }

  private async handleClientMessage(socket: WebSocket, serialized: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(serialized) as ClientMessage;
    } catch {
      this.send(socket, { type: 'error', code: 'invalid_json', message: 'message must be JSON' });
      return;
    }
    if (message.type === 'session.open') {
      await this.openSession(socket, message);
      return;
    }
    if (message.type === 'subscribe') {
      this.subscribe(socket, message);
      return;
    }
    if (message.type === 'action.request') {
      this.requestAction(socket, message);
      return;
    }
    this.send(socket, { type: 'error', code: 'invalid_message', message: 'unknown message type' });
  }

  private async openSession(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'session.open' }>,
  ): Promise<void> {
    if (!message.provider || typeof message.prompt !== 'string') {
      this.send(socket, {
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
      this.send(socket, { type: 'action.result', allowed: false, reason: decision.reason });
      return;
    }
    const sessionId = randomUUID();
    const streamId = `session:${sessionId}`;
    const openedSeq = this.appendEvent(streamId, 'session_started', {
      session_id: sessionId,
      provider: message.provider,
      prompt: message.prompt,
    });
    const worker = fork(this.workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
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
    this.send(socket, {
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

  private subscribe(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'subscribe' }>,
  ): void {
    const fromSeq = message.fromSeq ?? 0;
    if (!message.streamId || !Number.isInteger(fromSeq) || fromSeq < 0) {
      this.send(socket, {
        type: 'error',
        code: 'invalid_subscription',
        message: 'streamId and fromSeq are required',
      });
      return;
    }
    const subscriptions = this.clientSubscriptions.get(socket);
    if (!subscriptions) return;
    subscriptions.get(message.streamId)?.();
    const unsubscribe = this.eventStore.subscribe(message.streamId, fromSeq, (event) => {
      this.send(socket, { type: 'event', event });
    });
    subscriptions.set(message.streamId, unsubscribe);
    this.send(socket, {
      type: 'subscribed',
      streamId: message.streamId,
      fromSeq,
      cursor: this.eventStore.latestSequence(message.streamId),
    });
  }

  private requestAction(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: 'action.request' }>,
  ): void {
    const request_id = message.requestId ?? randomUUID();
    const stream_id = `action:${request_id}`;
    const requestedPayload = {
      request_id,
      action: message.action.type,
      scope: message.action.scope,
    };
    this.appendEvent(stream_id, 'action_requested', requestedPayload);
    const decision = this.authority.evaluate(message.action);
    const decisionType = decision.allowed ? 'action_approved' : 'action_denied';
    this.appendEvent(stream_id, decisionType, {
      ...requestedPayload,
      reason: decision.reason,
    });
    const response = {
      type: 'action.result',
      allowed: decision.allowed,
      reason: decision.reason,
      ...(message.requestId ? { requestId: message.requestId } : {}),
    };
    this.send(socket, response);
    if (!decision.allowed || message.action.type !== 'session.stop') return;
    const sessionId = message.action.scope.session_id;
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session || session.terminal) return;
    session.terminal = true;
    session.worker.kill();
  }

  private handleWorkerMessage(state: SessionState, message: WorkerOutputMessage): void {
    if (!message || message.stream_id !== state.streamId) return;
    if (message.type === 'event') {
      this.appendEvent(message.stream_id, message.event_type, message.payload);
      if (message.event_type === 'session_complete') state.terminal = true;
      return;
    }
    if (message.type === 'error') {
      this.failSession(state, message.message);
      return;
    }
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

  private cleanupClient(socket: WebSocket): void {
    const subscriptions = this.clientSubscriptions.get(socket);
    if (!subscriptions) return;
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    this.clientSubscriptions.delete(socket);
  }

  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    const serialized = JSON.stringify(body);
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(serialized),
    });
    response.end(serialized);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
