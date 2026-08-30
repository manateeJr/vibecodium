import type * as Commands from '../contracts/commands.js';
import type { EventEnvelope } from '../contracts/events.js';

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly webSocket?: SocketConstructor;
}

export interface VibecodiumClient {
  openSession(args: Commands.SessionOpenArgs): Promise<Commands.SessionOpenResult>;
  resumeSession(args: Commands.SessionResumeArgs): Promise<Commands.SessionResumeResult>;
  stopSession(args: Commands.SessionStopArgs): Promise<Commands.SessionStopResult>;
  sendMessage(args: Commands.SessionSendArgs): Promise<Commands.SessionSendResult>;
  listSessions(args: Commands.SessionListArgs): Promise<Commands.SessionListResult>;
  forkSession(args: Commands.SessionForkArgs): Promise<Commands.SessionForkResult>;
  sessionEnsureLive(
    args: Commands.SessionEnsureLiveArgs,
  ): Promise<Commands.SessionEnsureLiveResult>;
  sessionSendKeys(args: Commands.SessionSendKeysArgs): Promise<Commands.SessionSendKeysResult>;
  sessionAttachInfo(
    args: Commands.SessionAttachInfoArgs,
  ): Promise<Commands.SessionAttachInfoResult>;
  listWorkspaces(): Promise<Commands.WorkspaceListResult>;
  machineList(): Promise<Commands.MachineListResult>;
  workspaceStatus(args: Commands.WorkspaceStatusArgs): Promise<Commands.WorkspaceStatusResult>;
  listProjects(): Promise<Commands.ProjectListResult>;
  detectProject(args: Commands.ProjectDetectArgs): Promise<Commands.ProjectDetectResult>;
  saveProject(args: Commands.ProjectSaveArgs): Promise<Commands.ProjectSaveResult>;
  removeProject(args: Commands.ProjectRemoveArgs): Promise<Commands.ProjectRemoveResult>;
  transcribe(args: Commands.VoiceTranscribeArgs): Promise<Commands.VoiceTranscribeResult>;
  hostStats(): Promise<Commands.HostStatsResult>;
  setSessionCap(args: Commands.HostSetSessionCapArgs): Promise<Commands.HostSetSessionCapResult>;
  filesList(args: Commands.FilesListArgs): Promise<Commands.FilesListResult>;
  filesDownload(args: Commands.FilesDownloadArgs): Promise<Commands.FilesDownloadResult>;
  filesUpload(args: Commands.FilesUploadArgs): Promise<Commands.FilesUploadResult>;
  filesSharedDir(): Promise<Commands.FilesSharedDirResult>;
  skillList(): Promise<Commands.SkillListResult>;
  skillDraft(args: Commands.SkillDraftArgs): Promise<Commands.SkillDraftResult>;
  skillSave(args: Commands.SkillSaveArgs): Promise<Commands.SkillSaveResult>;
  skillRemove(args: Commands.SkillRemoveArgs): Promise<Commands.SkillRemoveResult>;
  skillAdopt(args: Commands.SkillAdoptArgs): Promise<Commands.SkillAdoptResult>;
  skillPropose(args: Commands.SkillProposeArgs): Promise<Commands.SkillProposeResult>;
  skillInvoke(args: Commands.SkillInvokeArgs): Promise<Commands.SkillInvokeResult>;
  runWorkflow(args: Commands.WorkflowRunArgs): Promise<Commands.WorkflowRunResult>;
  approve(args: Commands.WorkflowApproveArgs): Promise<Commands.WorkflowApproveResult>;
  getEvents(stream_id: string, from_seq: number): Promise<readonly EventEnvelope[]>;
  subscribe(
    from_seq: number,
    onEvent: (event: EventEnvelope) => void,
    streamId?: string,
  ): () => void;
  subscribePty(sessionId: string, listeners: PtyListeners): () => void;
  /** Force-close and reopen every live subscription socket, retaining each last-seen cursor. */
  reconnect(): void;
}

/**
 * Lifecycle of a PTY mirror socket. `disconnected` is followed by an automatic reconnect, and the
 * server's ring-buffer replay repaints the terminal, so the UI only has to say so.
 */
export type PtyStatus = 'connecting' | 'live' | 'disconnected' | 'unavailable' | 'error';

export interface PtyListeners {
  /** Raw PTY bytes, already base64-decoded. Never text: ANSI escapes must survive intact. */
  readonly onData: (data: Uint8Array) => void;
  readonly onStatus?: (status: PtyStatus, detail?: string) => void;
}

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  on?: (type: string, listener: (...args: unknown[]) => void) => void;
}

export type SocketConstructor = new (url: string) => SocketLike;
