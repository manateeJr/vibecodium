import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { tokensToCssVars } from '../design/tokens.js';
import { serveStaticAsset } from './static-assets.js';
import { errorMessage, readJsonBody } from './control-plane-helpers.js';
import { handleShareIntake } from './share-intake.js';
import {
  COMMAND_NAMES,
  type CommandFrame,
  type CommandServerFrame,
} from '../contracts/commands.js';
import type { PtyClientFrame } from '../contracts/session-commands.js';
import type { CapabilityTokenManager } from '../notify/index.js';
import type {
  CommandHandler,
  EventHandler,
  Subsystem,
  SubsystemContext,
} from '../contracts/subsystem.js';
import { PtyBridge } from './pty-bridge.js';
import { registerSubsystems } from '../subsystems/index.js';
import { Authority } from './authority.js';
import type { ScopedAction } from './authority.js';
import { EventStore } from './event-store.js';
import {
  CommandAuthorizationError,
  CommandDispatcher,
  capabilityVerifierFrom,
  sessionStopHandlersFrom,
} from './command-dispatcher.js';
const WEB_DIR = path.resolve(process.cwd(), 'web');
const CLIENT_BUNDLE = path.resolve(process.cwd(), 'dist/src/client/index.js');

export interface ControlPlaneOptions {
  readonly dataPath: string;
  readonly host?: string;
  readonly port?: number;
  readonly authority?: Authority;
  readonly subsystems?: readonly Subsystem[];
  readonly capabilityTokens?: Pick<CapabilityTokenManager, 'verify' | 'consume'>;
  readonly tokenVerifier?: Pick<CapabilityTokenManager, 'verify' | 'consume'>;
}

export type CommandTokenVerifier = Pick<CapabilityTokenManager, 'verify' | 'consume'>;
export interface ControlPlaneAddress {
  readonly host: string;
  readonly port: number;
  readonly httpUrl: string;
  readonly wsUrl: string;
}
export type ClientMessage =
  | PtyClientFrame
  | CommandFrame
  | {
      readonly type: 'subscribe';
      readonly streamId: string;
      readonly fromSeq?: number;
      readonly token?: string;
    }
  | {
      readonly type: 'action.request';
      readonly requestId?: string;
      readonly action: ScopedAction;
    };
export class ControlPlane {
  public readonly eventStore: EventStore;
  public readonly authority: Authority;
  public readonly context: SubsystemContext = {
    registerProjector: (name, onEvent, from_seq) => this.registerProjector(name, onEvent, from_seq),
    registerCommand: (name, handler) => this.register(this.commands, name, handler),
    registerListener: (name, handler) => this.registerListener(name, handler),
    append: (stream_id, type, payload) => this.eventStore.append(stream_id, type, payload),
    subscribe: (from_seq, onEvent) => this.eventStore.subscribeAll(from_seq, onEvent),
    registerPtySource: (subscribe) => this.ptyBridge.registerSource(subscribe),
  };
  private readonly host: string;
  private readonly port: number;
  private readonly projectors = new Map<string, EventHandler>();
  private readonly projectorSubscriptions = new Map<string, () => void>();
  private readonly commands = new Map<string, CommandHandler>();
  private readonly listeners = new Map<string, EventHandler>();
  private readonly listenerSubscriptions = new Map<string, () => void>();
  private readonly clientSubscriptions = new Map<WebSocket, Map<string, () => void>>();
  private readonly ptyBridge = new PtyBridge(this.clientSubscriptions, this.send.bind(this));
  private readonly tokenVerifier: CommandTokenVerifier | undefined;
  private readonly commandDispatcher: CommandDispatcher;
  private readonly sessionStopAll: readonly (() => void)[];
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
    const registeredSubsystems = registerSubsystems(this.context, options.subsystems, {
      sessionTableFilename: options.dataPath,
    });
    this.tokenVerifier =
      options.tokenVerifier ??
      options.capabilityTokens ??
      capabilityVerifierFrom(registeredSubsystems);
    this.sessionStopAll = sessionStopHandlersFrom(registeredSubsystems);
    this.commandDispatcher = new CommandDispatcher(this.commands, this.tokenVerifier);
    this.commandDispatcher.registerWorkflowRun();
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
    for (const stopAll of this.sessionStopAll) stopAll();
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
    for (const unsubscribe of this.projectorSubscriptions.values()) unsubscribe();
    for (const unsubscribe of this.listenerSubscriptions.values()) unsubscribe();
    this.projectorSubscriptions.clear();
    this.listenerSubscriptions.clear();
    this.eventStore.close();
  }
  private register<T>(registry: Map<string, T>, name: string, handler: T): void {
    if (!name.trim()) throw new Error('subsystem registration name is required');
    if (registry.has(name)) throw new Error(`duplicate subsystem registration: ${name}`);
    registry.set(name, handler);
  }
  private registerProjector(name: string, onEvent: EventHandler, from_seq?: number): void {
    this.register(this.projectors, name, onEvent);
    const cursor = from_seq ?? this.eventStore.projectorCursor(name);
    this.eventStore.saveProjectorCursor(name, cursor);
    const unsubscribe = this.eventStore.subscribeAll(cursor, (event) => {
      onEvent(event);
      this.eventStore.saveProjectorCursor(name, event.seq);
    });
    this.projectorSubscriptions.set(name, unsubscribe);
  }
  private registerListener(name: string, handler: EventHandler): void {
    this.register(this.listeners, name, handler);
    const unsubscribe = this.eventStore.subscribeAll(this.eventStore.latestSequence(), handler);
    this.listenerSubscriptions.set(name, unsubscribe);
  }
  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const commandPrefix = '/commands/';
    if (
      request.method === 'POST' &&
      requestUrl.pathname.startsWith(commandPrefix) &&
      requestUrl.pathname.length > commandPrefix.length
    ) {
      let commandName: string;
      try {
        commandName = decodeURIComponent(requestUrl.pathname.slice(commandPrefix.length));
      } catch {
        this.sendJson(response, 400, { error: 'invalid_command_name' });
        return;
      }
      void this.handleCommandHttp(
        request,
        response,
        commandName,
        bearerToken(request.headers.authorization),
      );
      return;
    }
    if (
      !isLoopbackAddress(request.socket.remoteAddress) &&
      !this.commandDispatcher.verifyToken(bearerToken(request.headers.authorization))
    ) {
      this.sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
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
    if (request.method === 'POST' && requestUrl.pathname === '/share-intake') {
      void handleShareIntake(request, response);
      return;
    }
    if (request.method === 'GET') {
      if (requestUrl.pathname === '/tokens.css') {
        this.sendAsset(response, 200, 'text/css', Buffer.from(tokensToCssVars()));
        return;
      }
      if (requestUrl.pathname === '/client.js') {
        try {
          this.sendAsset(response, 200, 'text/javascript', fs.readFileSync(CLIENT_BUNDLE));
        } catch {
          this.sendJson(response, 404, { error: 'not_found' });
        }
        return;
      }
      const asset = serveStaticAsset(WEB_DIR, requestUrl.pathname);
      if (asset.status === 200) {
        this.sendAsset(response, asset.status, asset.contentType, asset.body);
        return;
      }
    }
    this.sendJson(response, 404, { error: 'not_found' });
  }
  private async handleCommandHttp(
    request: IncomingMessage,
    response: ServerResponse,
    commandName: string,
    headerToken: string | undefined,
  ): Promise<void> {
    let args: unknown;
    try {
      args = await readJsonBody(request);
    } catch {
      this.sendJson(response, 400, { error: 'request body must be valid JSON' });
      return;
    }
    try {
      const value = await this.commandDispatcher.dispatch(
        commandName,
        args,
        headerToken,
        request.socket.remoteAddress,
      );
      this.sendJson(response, 200, { value });
    } catch (error: unknown) {
      const statusCode = error instanceof CommandAuthorizationError ? 401 : 400;
      this.sendJson(response, statusCode, { error: errorMessage(error) });
    }
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      this.send(socket, { type: 'error', code: 'invalid_json', message: 'message must be JSON' });
      return;
    }
    if (isCommandFrame(parsed)) {
      await this.handleCommandWebSocket(socket, parsed);
      return;
    }
    if (!isClientMessage(parsed)) {
      this.send(socket, {
        type: 'error',
        code: 'invalid_message',
        message: 'unknown message type',
      });
      return;
    }
    const message = parsed;
    if (
      !isLoopbackAddress(remoteAddress(socket)) &&
      !this.commandDispatcher.verifyToken('token' in message ? message.token : undefined)
    ) {
      this.send(socket, { type: 'error', code: 'unauthorized', message: 'unauthorized' });
      return;
    }
    if (message.type === 'pty_subscribe' || message.type === 'pty_unsubscribe')
      return this.ptyBridge.handle(socket, message);
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
  private async handleCommandWebSocket(socket: WebSocket, frame: CommandFrame): Promise<void> {
    const id = frame.id;
    if (!id || !frame.name) {
      this.send(socket, { id, type: 'error', message: 'command id and name are required' });
      return;
    }
    try {
      const value = await this.commandDispatcher.dispatch(
        frame.name,
        frame.args,
        frame.token,
        remoteAddress(socket),
      );
      const reply: CommandServerFrame = { id, type: 'result', value };
      this.send(socket, reply);
    } catch (error: unknown) {
      const reply: CommandServerFrame = { id, type: 'error', message: errorMessage(error) };
      this.send(socket, reply);
    }
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
    const onEvent = (event: Parameters<EventHandler>[0]): void => {
      this.send(socket, { type: 'event', event });
    };
    const unsubscribe =
      message.streamId === '*'
        ? this.eventStore.subscribeAll(fromSeq, onEvent)
        : this.eventStore.subscribe(message.streamId, fromSeq, onEvent);
    subscriptions.set(message.streamId, unsubscribe);
    this.send(socket, {
      type: 'subscribed',
      streamId: message.streamId,
      fromSeq,
      cursor:
        message.streamId === '*'
          ? this.eventStore.latestSequence()
          : this.eventStore.latestSequence(message.streamId),
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
    this.eventStore.append(stream_id, 'action_requested', requestedPayload);
    const decision = this.authority.evaluate(message.action);
    const decisionType = decision.allowed ? 'action_approved' : 'action_denied';
    this.eventStore.append(stream_id, decisionType, {
      ...requestedPayload,
      reason: decision.reason,
    });
    this.send(socket, {
      type: 'action.result',
      allowed: decision.allowed,
      reason: decision.reason,
      ...(message.requestId ? { requestId: message.requestId } : {}),
    });
    if (!decision.allowed || message.action.type !== 'session.stop') return;
    const sessionId = message.action.scope.session_id;
    if (!sessionId) return;
    const stop = this.commands.get(COMMAND_NAMES.sessionStop);
    if (stop) void stop({ session_id: sessionId });
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
  private sendAsset(
    response: ServerResponse,
    statusCode: number,
    contentType: string,
    body: Buffer,
  ): void {
    response.writeHead(statusCode, {
      'content-type': contentType,
      'content-length': body.byteLength,
    });
    response.end(body);
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

function isCommandFrame(value: unknown): value is CommandFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'command';
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>).type;
  return /^(?:subscribe|action\.request|pty_(?:subscribe|unsubscribe))$/.test(String(type));
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return true;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function remoteAddress(socket: WebSocket): string | undefined {
  return (socket as WebSocket & { _socket?: { remoteAddress?: string } })._socket?.remoteAddress;
}
