import type { EventEnvelope } from './events.js';
import { MACHINE_READ_COMMAND } from './machine-commands.js';
import type * as MachineCommands from './machine-commands.js';
import { FILES_SHARED_STAGED_COMMAND } from './files-commands.js';
import type * as FilesCommands from './files-commands.js';
import { SESSION_RECENT_COMMAND } from './session-recent.js';
import type * as SessionRecent from './session-recent.js';
import type {
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
  SessionPinArgs,
  SessionPinResult,
  SessionRenameArgs,
  SessionRenameResult,
  SessionResumeArgs,
  SessionResumeResult,
  SessionSendArgs,
  SessionSendKeysArgs,
  SessionSendKeysResult,
  SessionSendResult,
  SessionStopArgs,
  SessionStopResult,
} from './session-commands.js';
export type {
  PtyClientFrame,
  PtyDataFrame,
  PtyServerFrame,
  PtySubscribeFrame,
  PtyUnsubscribeFrame,
  SessionAttachInfoArgs,
  SessionAttachInfoResult,
  SessionEnsureLiveArgs,
  SessionEnsureLiveResult,
  SessionForkArgs,
  SessionForkResult,
  SessionListArgs,
  SessionListResult,
  SessionOrigin,
  SessionOpenArgs,
  SessionOpenResult,
  SessionPinArgs,
  SessionPinResult,
  SessionRenameArgs,
  SessionRenameResult,
  SessionResumeArgs,
  SessionResumeResult,
  SessionSendArgs,
  SessionSendKeysArgs,
  SessionSendKeysResult,
  SessionSendResult,
  SessionStopArgs,
  SessionStopResult,
  SessionSummary,
  SessionSource,
} from './session-commands.js';
export type * from './machine-commands.js';
export { MACHINE_READ_COMMAND, FILES_SHARED_STAGED_COMMAND, SESSION_RECENT_COMMAND };
export type * from './files-commands.js';
export type * from './session-recent.js';

export const COMMAND_NAMES = {
  sessionOpen: 'session.open',
  sessionRename: 'session.rename',
  sessionStop: 'session.stop',
  sessionSend: 'session.send',
  sessionList: 'session.list',
  sessionRecent: SESSION_RECENT_COMMAND,
  sessionFork: 'session.fork',
  sessionPin: 'session.pin',
  workspaceList: 'workspace.list',
  workflowRun: 'workflow.run',
  workflowApprove: 'workflow.approve',
  machineList: 'machine.list',
  machineRead: MACHINE_READ_COMMAND,
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
  filesSharedStaged: 'files.shared_staged',
  skillList: 'skill.list',
  skillDraft: 'skill.draft',
  skillSave: 'skill.save',
  skillRemove: 'skill.remove',
  skillAdopt: 'skill.adopt',
  skillPropose: 'skill.propose',
  skillInvoke: 'skill.invoke',
} as const;
export const SESSION_OPEN_COMMAND = COMMAND_NAMES.sessionOpen;
export const SESSION_RENAME_COMMAND = COMMAND_NAMES.sessionRename;
export const SESSION_STOP_COMMAND = COMMAND_NAMES.sessionStop;
export const SESSION_SEND_COMMAND = COMMAND_NAMES.sessionSend;
export const SESSION_LIST_COMMAND = COMMAND_NAMES.sessionList;
export const SESSION_FORK_COMMAND = COMMAND_NAMES.sessionFork;
export const SESSION_PIN_COMMAND = COMMAND_NAMES.sessionPin;
export const WORKSPACE_LIST_COMMAND = COMMAND_NAMES.workspaceList;
export const WORKFLOW_RUN_COMMAND = COMMAND_NAMES.workflowRun;
export const WORKFLOW_APPROVE_COMMAND = COMMAND_NAMES.workflowApprove;
export const WORKFLOW_START_COMMAND = 'workflow.start';
export const MACHINE_LIST_COMMAND = COMMAND_NAMES.machineList;
export const SESSION_RESUME_COMMAND = COMMAND_NAMES.sessionResume;
export const WORKSPACE_STATUS_COMMAND = COMMAND_NAMES.workspaceStatus;
export const PROJECT_LIST_COMMAND = COMMAND_NAMES.projectList;
export const PROJECT_DETECT_COMMAND = COMMAND_NAMES.projectDetect;
export const PROJECT_SAVE_COMMAND = COMMAND_NAMES.projectSave;
export const PROJECT_REMOVE_COMMAND = COMMAND_NAMES.projectRemove;
export const VOICE_TRANSCRIBE_COMMAND = COMMAND_NAMES.voiceTranscribe;
export const HOST_STATS_COMMAND = COMMAND_NAMES.hostStats;
export const HOST_SET_SESSION_CAP_COMMAND = COMMAND_NAMES.hostSetSessionCap;
export const SESSION_ENSURE_LIVE_COMMAND = COMMAND_NAMES.sessionEnsureLive;
export const SESSION_SEND_KEYS_COMMAND = COMMAND_NAMES.sessionSendKeys;
export const SESSION_ATTACH_INFO_COMMAND = COMMAND_NAMES.sessionAttachInfo;
export const FILES_LIST_COMMAND = COMMAND_NAMES.filesList;
export const FILES_DOWNLOAD_COMMAND = COMMAND_NAMES.filesDownload;
export const FILES_UPLOAD_COMMAND = COMMAND_NAMES.filesUpload;
export const FILES_SHARED_DIR_COMMAND = COMMAND_NAMES.filesSharedDir;
export const SKILL_LIST_COMMAND = COMMAND_NAMES.skillList;
export const SKILL_DRAFT_COMMAND = COMMAND_NAMES.skillDraft;
export const SKILL_SAVE_COMMAND = COMMAND_NAMES.skillSave;
export const SKILL_REMOVE_COMMAND = COMMAND_NAMES.skillRemove;
export const SKILL_ADOPT_COMMAND = COMMAND_NAMES.skillAdopt;
export const SKILL_PROPOSE_COMMAND = COMMAND_NAMES.skillPropose;
export const SKILL_INVOKE_COMMAND = COMMAND_NAMES.skillInvoke;

export type CommandName = (typeof COMMAND_NAMES)[keyof typeof COMMAND_NAMES];

export interface WorkspaceEntry {
  readonly name: string;
  readonly path: string;
}

export type WorkspaceListArgs = Record<string, never>;

export interface WorkspaceListResult {
  readonly workspaces: readonly WorkspaceEntry[];
}

export interface WorkspaceStatusArgs {
  readonly path: string;
}

export interface WorkspaceStatusResult {
  readonly branch: string;
  readonly dirty: boolean;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface QuickAction {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

export interface Project {
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly quickActions: readonly QuickAction[];
  readonly scope: 'project';
}

export type ProjectListArgs = Record<string, never>;

export interface ProjectListResult {
  readonly projects: readonly Project[];
}

export interface ProjectDetectArgs {
  readonly path: string;
  readonly description?: string;
}

export interface ProjectDetectResult {
  readonly proposed: readonly QuickAction[];
}

export interface ProjectSaveArgs {
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly quickActions: readonly QuickAction[];
}

export interface ProjectSaveResult {
  readonly project: Project;
}

export interface ProjectRemoveArgs {
  readonly name: string;
}

export interface ProjectRemoveResult {
  readonly removed: boolean;
}

export interface WorkflowRunArgs extends Readonly<Record<string, unknown>> {
  readonly template: string;
}

export interface WorkflowRunResult {
  readonly stream_id: string;
}

export interface WorkflowApproveArgs extends Readonly<Record<string, unknown>> {
  readonly stream_id?: string;
  readonly token?: string;
}

export interface WorkflowApproveResult {
  readonly workflow_id: string;
  readonly template: string;
  readonly stage: string;
  readonly status: string;
  readonly approved: boolean;
  readonly approval_request_id: string | null;
  readonly failure_packet: unknown;
  readonly blocked: boolean;
  readonly reason: string | null;
}

export interface VoiceTranscribeArgs {
  readonly audio_base64: string;
  readonly mime?: string;
}

export interface VoiceTranscribeResult {
  readonly text: string;
}

export type HostStatsArgs = Record<string, never>;

export interface HostStatsResult {
  readonly mem_total: number;
  readonly mem_used: number;
  readonly load: readonly number[];
  readonly uptime_seconds: number;
  readonly vibecodium_sessions: number;
  readonly global_sessions: number;
  readonly max_concurrent: number;
}

export interface HostSetSessionCapArgs {
  readonly max_concurrent: number;
}

export interface HostSetSessionCapResult {
  readonly max_concurrent: number;
}
export interface SkillParam {
  readonly name: string;
  readonly type: 'text' | 'enum' | 'bool';
  readonly required: boolean;
  readonly default?: string;
  readonly options?: readonly string[];
  readonly source: 'prompt' | 'agent';
}
export interface SkillDef {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly body: string;
  readonly params: readonly SkillParam[];
  readonly approval?: boolean;
  readonly builtin: boolean;
}
export type SkillListArgs = Record<string, never>;
export interface SkillListResult {
  readonly skills: readonly SkillDef[];
  readonly adoptions: Readonly<Record<string, readonly string[]>>;
}
export interface SkillDraftArgs {
  readonly seed: {
    readonly name: string;
    readonly body?: string;
    readonly params?: readonly SkillParam[];
    readonly mode: 'form' | 'conversation';
    readonly conversation?: string;
  };
}
export interface SkillDraftResult {
  readonly def: SkillDef;
}
export interface SkillSaveArgs {
  readonly def: SkillDef;
}
export interface SkillSaveResult {
  readonly def: SkillDef;
}
export interface SkillRemoveArgs {
  readonly id: string;
}
export interface SkillRemoveResult {
  readonly removed: boolean;
}
export interface SkillAdoptArgs {
  readonly project: string;
  readonly skill_id: string;
  readonly adopt: boolean;
}
export interface SkillAdoptResult {
  readonly adopted: readonly string[];
}
export interface SkillProposeArgs {
  readonly project: string;
}
export interface SkillProposeResult {
  readonly proposed: readonly string[];
}
export interface SkillInvokeArgs {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}
export interface SkillInvokeResult {
  readonly prompt: string;
}
export interface CommandArgsMap {
  'session.open': SessionOpenArgs;
  'session.rename': SessionRenameArgs;
  'session.stop': SessionStopArgs;
  'session.send': SessionSendArgs;
  'workspace.list': WorkspaceListArgs;
  'workflow.run': WorkflowRunArgs;
  'workflow.approve': WorkflowApproveArgs;
  'machine.list': MachineCommands.MachineListArgs;
  'machine.read': MachineCommands.MachineReadArgs;
  'session.resume': SessionResumeArgs;
  'workspace.status': WorkspaceStatusArgs;
  'project.list': ProjectListArgs;
  'project.detect': ProjectDetectArgs;
  'project.save': ProjectSaveArgs;
  'project.remove': ProjectRemoveArgs;
  'session.list': SessionListArgs;
  'session.recent': SessionRecent.SessionRecentArgs;
  'session.fork': SessionForkArgs;
  'session.pin': SessionPinArgs;
  'voice.transcribe': VoiceTranscribeArgs;
  'host.stats': HostStatsArgs;
  'host.set_session_cap': HostSetSessionCapArgs;
  'session.ensure_live': SessionEnsureLiveArgs;
  'session.send_keys': SessionSendKeysArgs;
  'session.attach_info': SessionAttachInfoArgs;
  'files.list': FilesCommands.FilesListArgs;
  'files.download': FilesCommands.FilesDownloadArgs;
  'files.upload': FilesCommands.FilesUploadArgs;
  'files.shared_dir': FilesCommands.FilesSharedDirArgs;
  'files.shared_staged': FilesCommands.FilesSharedStagedArgs;
  'skill.list': SkillListArgs;
  'skill.draft': SkillDraftArgs;
  'skill.save': SkillSaveArgs;
  'skill.remove': SkillRemoveArgs;
  'skill.adopt': SkillAdoptArgs;
  'skill.propose': SkillProposeArgs;
  'skill.invoke': SkillInvokeArgs;
}

export interface CommandResultMap {
  'session.open': SessionOpenResult;
  'session.rename': SessionRenameResult;
  'session.send': SessionSendResult;
  'workspace.list': WorkspaceListResult;
  'session.stop': SessionStopResult;
  'workflow.run': WorkflowRunResult;
  'workflow.approve': WorkflowApproveResult;
  'machine.list': MachineCommands.MachineListResult;
  'machine.read': MachineCommands.MachineReadResult;
  'session.resume': SessionResumeResult;
  'workspace.status': WorkspaceStatusResult;
  'project.list': ProjectListResult;
  'project.detect': ProjectDetectResult;
  'project.save': ProjectSaveResult;
  'project.remove': ProjectRemoveResult;
  'session.list': SessionListResult;
  'session.recent': SessionRecent.SessionRecentResult;
  'session.fork': SessionForkResult;
  'session.pin': SessionPinResult;
  'voice.transcribe': VoiceTranscribeResult;
  'host.stats': HostStatsResult;
  'host.set_session_cap': HostSetSessionCapResult;
  'session.ensure_live': SessionEnsureLiveResult;
  'session.send_keys': SessionSendKeysResult;
  'session.attach_info': SessionAttachInfoResult;
  'files.list': FilesCommands.FilesListResult;
  'files.download': FilesCommands.FilesDownloadResult;
  'files.upload': FilesCommands.FilesUploadResult;
  'files.shared_dir': FilesCommands.FilesSharedDirResult;
  'files.shared_staged': FilesCommands.FilesSharedStagedResult;
  'skill.list': SkillListResult;
  'skill.draft': SkillDraftResult;
  'skill.save': SkillSaveResult;
  'skill.remove': SkillRemoveResult;
  'skill.adopt': SkillAdoptResult;
  'skill.propose': SkillProposeResult;
  'skill.invoke': SkillInvokeResult;
}

export type CommandArgs<Name extends CommandName = CommandName> = CommandArgsMap[Name];
export type CommandResult<Name extends CommandName = CommandName> = CommandResultMap[Name];

export interface CommandFrame<Name extends string = string> {
  readonly id: string;
  readonly type: 'command';
  readonly name: Name;
  readonly args?: unknown;
  readonly token?: string;
}

export interface CommandResultFrame {
  readonly id: string;
  readonly type: 'result';
  readonly value: unknown;
}

export interface CommandErrorFrame {
  readonly id: string;
  readonly type: 'error';
  readonly message: string;
}

export type CommandServerFrame = CommandResultFrame | CommandErrorFrame;

export interface CommandHttpSuccess {
  readonly value: unknown;
}

export interface CommandHttpError {
  readonly error: string;
}

export type CommandHttpResponse = CommandHttpSuccess | CommandHttpError;

export interface EventsHttpResponse {
  readonly events: readonly EventEnvelope[];
}

export interface SubscribeFrame {
  readonly type: 'subscribe';
  readonly streamId?: string;
  readonly fromSeq?: number;
  readonly token?: string;
}

export interface EventFrame {
  readonly type: 'event';
  readonly event: EventEnvelope;
}

export interface SubscribedFrame {
  readonly type: 'subscribed';
  readonly streamId?: string;
  readonly fromSeq: number;
  readonly cursor: number;
}
