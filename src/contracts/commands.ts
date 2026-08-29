import type { EventEnvelope } from './events.js';

export const COMMAND_NAMES = {
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
} as const;
export const SESSION_OPEN_COMMAND = COMMAND_NAMES.sessionOpen;
export const SESSION_STOP_COMMAND = COMMAND_NAMES.sessionStop;
export const SESSION_SEND_COMMAND = COMMAND_NAMES.sessionSend;
export const SESSION_LIST_COMMAND = COMMAND_NAMES.sessionList;
export const SESSION_FORK_COMMAND = COMMAND_NAMES.sessionFork;
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

export type CommandName = (typeof COMMAND_NAMES)[keyof typeof COMMAND_NAMES];

export interface SessionOpenArgs {
  readonly provider: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly project?: string;
}

export interface SessionOpenResult {
  readonly session_id: string;
  readonly stream_id: string;
}

export interface MachineSessionSummary {
  readonly source: 'omp' | 'codex';
  readonly ref: string;
  readonly title: string;
  readonly cwd: string;
  readonly updated_at: string;
}

export type MachineListArgs = Record<string, never>;

export interface MachineListResult {
  readonly sessions: readonly MachineSessionSummary[];
}

export interface SessionResumeArgs {
  readonly source: 'omp' | 'codex';
  readonly ref: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly project?: string;
}

export type SessionResumeResult = SessionOpenResult;

export interface SessionStopArgs {
  readonly session_id: string;
}

export interface SessionStopResult {
  readonly stopped: boolean;
}

export interface SessionSendArgs {
  readonly session_id: string;
  readonly prompt: string;
}

export interface SessionSendResult {
  readonly stream_id: string;
  readonly turn: number;
}

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
export interface SessionListArgs {
  readonly project?: string;
  readonly limit?: number;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: string;
  readonly project?: string;
  readonly cwd?: string;
  readonly status: 'live' | 'done' | 'failed' | 'stopped';
  readonly prompt?: string;
  readonly started_at?: string;
  readonly updated_at?: string;
}

export interface SessionListResult {
  readonly sessions: readonly SessionSummary[];
}

export interface SessionForkArgs {
  readonly session_id: string;
}

export interface SessionForkResult {
  readonly new_session_id: string;
  readonly provider: string;
  readonly continue_command: string;
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

export interface CommandArgsMap {
  'session.open': SessionOpenArgs;
  'session.stop': SessionStopArgs;
  'session.send': SessionSendArgs;
  'workspace.list': WorkspaceListArgs;
  'workflow.run': WorkflowRunArgs;
  'workflow.approve': WorkflowApproveArgs;
  'machine.list': MachineListArgs;
  'session.resume': SessionResumeArgs;
  'workspace.status': WorkspaceStatusArgs;
  'project.list': ProjectListArgs;
  'project.detect': ProjectDetectArgs;
  'project.save': ProjectSaveArgs;
  'project.remove': ProjectRemoveArgs;
  'session.list': SessionListArgs;
  'session.fork': SessionForkArgs;
  'voice.transcribe': VoiceTranscribeArgs;
  'host.stats': HostStatsArgs;
  'host.set_session_cap': HostSetSessionCapArgs;
}

export interface CommandResultMap {
  'session.open': SessionOpenResult;
  'session.send': SessionSendResult;
  'workspace.list': WorkspaceListResult;
  'session.stop': SessionStopResult;
  'workflow.run': WorkflowRunResult;
  'workflow.approve': WorkflowApproveResult;
  'machine.list': MachineListResult;
  'session.resume': SessionResumeResult;
  'workspace.status': WorkspaceStatusResult;
  'project.list': ProjectListResult;
  'project.detect': ProjectDetectResult;
  'project.save': ProjectSaveResult;
  'project.remove': ProjectRemoveResult;
  'session.list': SessionListResult;
  'session.fork': SessionForkResult;
  'voice.transcribe': VoiceTranscribeResult;
  'host.stats': HostStatsResult;
  'host.set_session_cap': HostSetSessionCapResult;
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
