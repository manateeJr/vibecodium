import type {
  EventsHttpResponse,
  HostSetSessionCapArgs,
  HostSetSessionCapResult,
  HostStatsResult,
  MachineListResult,
  ProjectDetectArgs,
  ProjectDetectResult,
  ProjectListResult,
  ProjectRemoveArgs,
  ProjectRemoveResult,
  ProjectSaveArgs,
  ProjectSaveResult,
  SessionAttachInfoArgs,
  SessionAttachInfoResult,
  SessionEnsureLiveArgs,
  SessionEnsureLiveResult,
  SessionForkArgs,
  SessionForkResult,
  SessionListArgs,
  SessionListResult,
  SessionOpenArgs,
  SessionOpenResult,
  SessionResumeArgs,
  SessionResumeResult,
  SessionSendArgs,
  SessionSendKeysArgs,
  SessionSendKeysResult,
  SessionSendResult,
  SessionStopArgs,
  SessionStopResult,
  SubscribeFrame,
  WorkflowApproveArgs,
  WorkflowApproveResult,
  WorkflowRunArgs,
  WorkflowRunResult,
  VoiceTranscribeArgs,
  VoiceTranscribeResult,
  WorkspaceListResult,
  WorkspaceStatusArgs,
  WorkspaceStatusResult,
} from '../contracts/commands.js';
import type * as Commands from '../contracts/commands.js';
import type { EventEnvelope } from '../contracts/events.js';

import type { ClientOptions, SocketConstructor, SocketLike, VibecodiumClient } from './types.js';
// Keep command names local so /client.js remains a standalone browser module.
const COMMAND_NAMES = {
  sessionOpen: 'session.open',
  sessionStop: 'session.stop',
  sessionSend: 'session.send',
  sessionList: 'session.list',
  sessionFork: 'session.fork',
  workspaceList: 'workspace.list',
  workflowRun: 'workflow.run',
  workflowApprove: 'workflow.approve',
  machineList: 'machine.list',
  sessionResume: 'session.resume',
  workspaceStatus: 'workspace.status',
  projectList: 'project.list',
  projectDetect: 'project.detect',
  projectSave: 'project.save',
  projectRemove: 'project.remove',
  voiceTranscribe: 'voice.transcribe',
  hostStats: 'host.stats',
  hostSetSessionCap: 'host.set_session_cap',
  sessionEnsureLive: 'session.ensure_live',
  sessionSendKeys: 'session.send_keys',
  sessionAttachInfo: 'session.attach_info',
  filesList: 'files.list',
  filesDownload: 'files.download',
  filesUpload: 'files.upload',
  filesSharedDir: 'files.shared_dir',
  skillList: 'skill.list',
  skillDraft: 'skill.draft',
  skillSave: 'skill.save',
  skillRemove: 'skill.remove',
  skillAdopt: 'skill.adopt',
  skillPropose: 'skill.propose',
  skillInvoke: 'skill.invoke',
} as const;
export type { ClientOptions, VibecodiumClient } from './types.js';

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
  EventsHttpResponse,
  HostSetSessionCapArgs,
  HostSetSessionCapResult,
  HostStatsResult,
  MachineListResult,
  MachineSessionSummary,
  SessionAttachInfoArgs,
  SessionAttachInfoResult,
  SessionEnsureLiveArgs,
  SessionEnsureLiveResult,
  SessionForkArgs,
  SessionForkResult,
  SessionListArgs,
  SessionListResult,
  Project,
  ProjectDetectArgs,
  ProjectDetectResult,
  ProjectListResult,
  ProjectRemoveArgs,
  ProjectRemoveResult,
  ProjectSaveArgs,
  ProjectSaveResult,
  QuickAction,
  SessionOpenArgs,
  SessionOpenResult,
  SessionResumeArgs,
  SessionResumeResult,
  SessionSendArgs,
  SessionSendKeysArgs,
  SessionSendKeysResult,
  SessionSendResult,
  SessionStopArgs,
  SessionStopResult,
  VoiceTranscribeArgs,
  VoiceTranscribeResult,
  SubscribeFrame,
  WorkflowApproveArgs,
  WorkflowApproveResult,
  WorkflowRunArgs,
  WorkflowRunResult,
  WorkspaceEntry,
  WorkspaceListArgs,
  WorkspaceListResult,
  WorkspaceStatusArgs,
  WorkspaceStatusResult,
} from '../contracts/commands.js';
export type * from '../contracts/commands.js';

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

  const resumeSession = async (args: SessionResumeArgs): Promise<SessionResumeResult> => {
    const result = await post<SessionResumeResult>(
      baseUrl,
      COMMAND_NAMES.sessionResume,
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
  const listSessions = (args: SessionListArgs): Promise<SessionListResult> =>
    post<SessionListResult>(baseUrl, COMMAND_NAMES.sessionList, args, options.token);
  const forkSession = (args: SessionForkArgs): Promise<SessionForkResult> =>
    post<SessionForkResult>(baseUrl, COMMAND_NAMES.sessionFork, args, options.token);
  const sessionEnsureLive = (args: SessionEnsureLiveArgs): Promise<SessionEnsureLiveResult> =>
    post<SessionEnsureLiveResult>(baseUrl, COMMAND_NAMES.sessionEnsureLive, args, options.token);
  const sessionSendKeys = (args: SessionSendKeysArgs): Promise<SessionSendKeysResult> =>
    post<SessionSendKeysResult>(baseUrl, COMMAND_NAMES.sessionSendKeys, args, options.token);
  const sessionAttachInfo = (args: SessionAttachInfoArgs): Promise<SessionAttachInfoResult> =>
    post<SessionAttachInfoResult>(baseUrl, COMMAND_NAMES.sessionAttachInfo, args, options.token);

  const listWorkspaces = (): Promise<WorkspaceListResult> =>
    post<WorkspaceListResult>(baseUrl, COMMAND_NAMES.workspaceList, {}, options.token);

  const machineList = (): Promise<MachineListResult> =>
    post<MachineListResult>(baseUrl, COMMAND_NAMES.machineList, {}, options.token);
  const workspaceStatus = (args: WorkspaceStatusArgs): Promise<WorkspaceStatusResult> =>
    post<WorkspaceStatusResult>(baseUrl, COMMAND_NAMES.workspaceStatus, args, options.token);
  const listProjects = (): Promise<ProjectListResult> =>
    post<ProjectListResult>(baseUrl, COMMAND_NAMES.projectList, {}, options.token);
  const detectProject = (args: ProjectDetectArgs): Promise<ProjectDetectResult> =>
    post<ProjectDetectResult>(baseUrl, COMMAND_NAMES.projectDetect, args, options.token);
  const saveProject = (args: ProjectSaveArgs): Promise<ProjectSaveResult> =>
    post<ProjectSaveResult>(baseUrl, COMMAND_NAMES.projectSave, args, options.token);
  const removeProject = (args: ProjectRemoveArgs): Promise<ProjectRemoveResult> =>
    post<ProjectRemoveResult>(baseUrl, COMMAND_NAMES.projectRemove, args, options.token);
  const transcribe = (args: VoiceTranscribeArgs): Promise<VoiceTranscribeResult> =>
    post<VoiceTranscribeResult>(baseUrl, COMMAND_NAMES.voiceTranscribe, args, options.token);
  const hostStats = (): Promise<HostStatsResult> =>
    post<HostStatsResult>(baseUrl, COMMAND_NAMES.hostStats, {}, options.token);
  const setSessionCap = (args: HostSetSessionCapArgs): Promise<HostSetSessionCapResult> =>
    post<HostSetSessionCapResult>(baseUrl, COMMAND_NAMES.hostSetSessionCap, args, options.token);

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
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let lastSeq = from_seq;
    let firstConnection = true;
    const browserWebSocket: unknown = globalThis.WebSocket;
    const Socket =
      options.webSocket ??
      (typeof browserWebSocket === 'function'
        ? (browserWebSocket as SocketConstructor)
        : undefined);
    const subscribedStreamId = streamId ?? activeStreamId ?? '*';
    const scheduleReconnect = (): void => {
      if (cancelled || reconnectTimer !== undefined || !Socket) return;
      const delay = Math.min(5_000, 50 * 2 ** Math.min(reconnectAttempt, 7));
      reconnectAttempt += 1;
      reconnectTimer = globalThis.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };
    const connect = (): void => {
      if (cancelled || !Socket) return;
      let nextSocket: SocketLike;
      try {
        nextSocket = new Socket(websocketUrl(baseUrl));
      } catch {
        scheduleReconnect();
        return;
      }
      socket = nextSocket;
      const frameFromSeq = firstConnection ? from_seq : lastSeq + 1;
      firstConnection = false;
      const sendFrame = (): void => {
        if (cancelled || socket !== nextSocket || nextSocket.readyState !== OPEN_STATE) return;
        const frame: SubscribeFrame = {
          type: 'subscribe',
          streamId: subscribedStreamId,
          fromSeq: frameFromSeq,
          ...(options.token === undefined ? {} : { token: options.token }),
        };
        nextSocket.send(JSON.stringify(frame));
      };
      addSocketListener(nextSocket, 'open', () => {
        reconnectAttempt = 0;
        sendFrame();
      });
      addSocketListener(nextSocket, 'message', (event) => {
        if (cancelled || socket !== nextSocket) return;
        const message = parseSocketMessage(event);
        if (message?.type !== 'event' || !isEventEnvelope(message.event)) return;
        lastSeq = Math.max(lastSeq, message.event.seq);
        onEvent(message.event);
      });
      addSocketListener(nextSocket, 'close', () => {
        if (cancelled || socket !== nextSocket) return;
        socket = undefined;
        scheduleReconnect();
      });
    };
    if (Socket) connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const currentSocket = socket;
      socket = undefined;
      currentSocket?.close();
    };
  };

  const postCommand = <Name extends Commands.CommandName>(
    name: Name,
    args: Commands.CommandArgs<Name>,
  ): Promise<Commands.CommandResult<Name>> =>
    post<Commands.CommandResult<Name>>(baseUrl, name, args, options.token);
  return {
    openSession,
    resumeSession,
    stopSession,
    sendMessage,
    listSessions,
    forkSession,
    sessionEnsureLive,
    sessionSendKeys,
    sessionAttachInfo,
    listWorkspaces,
    machineList,
    workspaceStatus,
    listProjects,
    detectProject,
    saveProject,
    removeProject,
    transcribe,
    hostStats,
    setSessionCap,
    runWorkflow,
    approve,
    filesList: (args: Commands.FilesListArgs) => postCommand(COMMAND_NAMES.filesList, args),
    filesDownload: (args: Commands.FilesDownloadArgs) =>
      postCommand(COMMAND_NAMES.filesDownload, args),
    filesUpload: (args: Commands.FilesUploadArgs) => postCommand(COMMAND_NAMES.filesUpload, args),
    filesSharedDir: () => postCommand(COMMAND_NAMES.filesSharedDir, {}),
    skillList: () => postCommand(COMMAND_NAMES.skillList, {}),
    skillDraft: (args: Commands.SkillDraftArgs) => postCommand(COMMAND_NAMES.skillDraft, args),
    skillSave: (args: Commands.SkillSaveArgs) => postCommand(COMMAND_NAMES.skillSave, args),
    skillRemove: (args: Commands.SkillRemoveArgs) => postCommand(COMMAND_NAMES.skillRemove, args),
    skillAdopt: (args: Commands.SkillAdoptArgs) => postCommand(COMMAND_NAMES.skillAdopt, args),
    skillPropose: (args: Commands.SkillProposeArgs) =>
      postCommand(COMMAND_NAMES.skillPropose, args),
    skillInvoke: (args: Commands.SkillInvokeArgs) => postCommand(COMMAND_NAMES.skillInvoke, args),
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
