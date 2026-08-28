import type {
  EventsHttpResponse,
  SessionOpenArgs,
  SessionOpenResult,
  SessionSendArgs,
  SessionSendResult,
  SessionStopArgs,
  SessionStopResult,
  SubscribeFrame,
  WorkflowApproveArgs,
  WorkflowApproveResult,
  WorkflowRunArgs,
  WorkflowRunResult,
  WorkspaceListResult,
} from '../contracts/commands.js';
import type { EventEnvelope } from '../contracts/events.js';

// Keep command names local so /client.js remains a standalone browser module.
const COMMAND_NAMES = {
  sessionOpen: 'session.open',
  sessionStop: 'session.stop',
  sessionSend: 'session.send',
  workspaceList: 'workspace.list',
  workflowRun: 'workflow.run',
  workflowApprove: 'workflow.approve',
} as const;

export type {
  CommandArgs,
  CommandArgsMap,
  CommandErrorFrame,
  CommandFrame,
  CommandHttpError,
  CommandHttpResponse,
  CommandHttpSuccess,
  CommandName,
  CommandResult,
  CommandResultFrame,
  CommandResultMap,
  CommandServerFrame,
  EventsHttpResponse,
  SessionOpenArgs,
  SessionOpenResult,
  SessionSendArgs,
  SessionSendResult,
  SessionStopArgs,
  SessionStopResult,
  SubscribeFrame,
  WorkflowApproveArgs,
  WorkflowApproveResult,
  WorkflowRunArgs,
  WorkflowRunResult,
  WorkspaceEntry,
  WorkspaceListArgs,
  WorkspaceListResult,
} from '../contracts/commands.js';

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly webSocket?: SocketConstructor;
}

export interface VibecodiumClient {
  openSession(args: SessionOpenArgs): Promise<SessionOpenResult>;
  stopSession(args: SessionStopArgs): Promise<SessionStopResult>;
  sendMessage(args: SessionSendArgs): Promise<SessionSendResult>;
  listWorkspaces(): Promise<WorkspaceListResult>;
  runWorkflow(args: WorkflowRunArgs): Promise<WorkflowRunResult>;
  approve(args: WorkflowApproveArgs): Promise<WorkflowApproveResult>;
  getEvents(stream_id: string, from_seq: number): Promise<readonly EventEnvelope[]>;
  subscribe(
    from_seq: number,
    onEvent: (event: EventEnvelope) => void,
    streamId?: string,
  ): () => void;
}

interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  on?: (type: string, listener: (...args: unknown[]) => void) => void;
}

type SocketConstructor = new (url: string) => SocketLike;

const OPEN_STATE = 1;

export function createClient(options: ClientOptions): VibecodiumClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  let activeStreamId: string | undefined;

  const openSession = async (args: SessionOpenArgs): Promise<SessionOpenResult> => {
    const result = await post<SessionOpenResult>(
      baseUrl,
      COMMAND_NAMES.sessionOpen,
      args,
      options.token,
    );
    activeStreamId = result.stream_id;
    return result;
  };

  const stopSession = (args: SessionStopArgs): Promise<SessionStopResult> =>
    post<SessionStopResult>(baseUrl, COMMAND_NAMES.sessionStop, args, options.token);
  const sendMessage = (args: SessionSendArgs): Promise<SessionSendResult> =>
    post<SessionSendResult>(baseUrl, COMMAND_NAMES.sessionSend, args, options.token);

  const listWorkspaces = (): Promise<WorkspaceListResult> =>
    post<WorkspaceListResult>(baseUrl, COMMAND_NAMES.workspaceList, {}, options.token);

  const runWorkflow = async (args: WorkflowRunArgs): Promise<WorkflowRunResult> => {
    const result = await post<WorkflowRunResult>(
      baseUrl,
      COMMAND_NAMES.workflowRun,
      args,
      options.token,
    );
    activeStreamId = result.stream_id;
    return result;
  };

  const approve = (args: WorkflowApproveArgs): Promise<WorkflowApproveResult> =>
    post<WorkflowApproveResult>(
      baseUrl,
      COMMAND_NAMES.workflowApprove,
      args,
      options.token ?? args.token,
    );

  const getEvents = async (
    stream_id: string,
    from_seq: number,
  ): Promise<readonly EventEnvelope[]> => {
    const url = new URL('/events', `${baseUrl}/`);
    url.searchParams.set('stream_id', stream_id);
    url.searchParams.set('from_seq', String(from_seq));
    const response = await fetchJson<EventsHttpResponse>(url.toString(), options.token);
    if (!Array.isArray(response.events)) throw new Error('control plane returned invalid events');
    return response.events;
  };

  const subscribe = (
    from_seq: number,
    onEvent: (event: EventEnvelope) => void,
    streamId?: string,
  ): (() => void) => {
    let cancelled = false;
    let socket: SocketLike | undefined;
    const browserWebSocket: unknown = globalThis.WebSocket;
    const Socket =
      options.webSocket ??
      (typeof browserWebSocket === 'function'
        ? (browserWebSocket as SocketConstructor)
        : undefined);
    if (Socket) {
      try {
        socket = new Socket(websocketUrl(baseUrl));
        const frame: SubscribeFrame = {
          type: 'subscribe',
          streamId: streamId ?? activeStreamId ?? '*',
          fromSeq: from_seq,
          ...(options.token === undefined ? {} : { token: options.token }),
        };
        const sendFrame = (): void => {
          if (!cancelled && socket?.readyState === OPEN_STATE) socket.send(JSON.stringify(frame));
        };
        addSocketListener(socket, 'open', sendFrame);
        addSocketListener(socket, 'message', (event) => {
          const message = parseSocketMessage(event);
          if (message?.type === 'event' && isEventEnvelope(message.event)) onEvent(message.event);
        });
      } catch {
        socket?.close();
      }
    }
    return () => {
      cancelled = true;
      socket?.close();
    };
  };

  return {
    openSession,
    stopSession,
    sendMessage,
    listWorkspaces,
    runWorkflow,
    approve,
    getEvents,
    subscribe,
  };
}

async function post<T>(
  baseUrl: string,
  name: string,
  args: unknown,
  token: string | undefined,
): Promise<T> {
  const body = await fetchJson<{ readonly value?: unknown }>(`${baseUrl}/commands/${name}`, token, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(args),
  });
  if (!isRecord(body) || !('value' in body))
    throw new Error('control plane returned an invalid response');
  return body.value as T;
}

async function fetchJson<T>(url: string, token?: string, init?: RequestInit): Promise<T> {
  if (typeof globalThis.fetch !== 'function') throw new Error('global fetch is unavailable');
  const headers = new Headers(init?.headers);
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  const response = await globalThis.fetch(url, { ...init, headers });
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    throw new Error(`control plane returned HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(errorFromBody(body, response.status));
  if (!isRecord(body) || (!('value' in body) && !('events' in body)))
    throw new Error('control plane returned an invalid response');
  return body as T;
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('baseUrl is required');
  return normalized;
}

function websocketUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`;
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`;
  return baseUrl;
}

function addSocketListener(
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

function parseSocketMessage(event: unknown): Record<string, unknown> | undefined {
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

function isEventEnvelope(value: unknown): value is EventEnvelope {
  return isRecord(value) && typeof value.stream_id === 'string' && typeof value.seq === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorFromBody(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string') return body.error;
  return `control plane returned HTTP ${status}`;
}
