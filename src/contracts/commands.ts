import type { EventEnvelope } from './events.js';

export const COMMAND_NAMES = {
  sessionOpen: 'session.open',
  sessionStop: 'session.stop',
  sessionSend: 'session.send',
  workspaceList: 'workspace.list',
  workflowRun: 'workflow.run',
  workflowApprove: 'workflow.approve',
  machineList: 'machine.list',
  sessionResume: 'session.resume',
  workspaceStatus: 'workspace.status',
} as const;
export const SESSION_OPEN_COMMAND = COMMAND_NAMES.sessionOpen;
export const SESSION_STOP_COMMAND = COMMAND_NAMES.sessionStop;
export const SESSION_SEND_COMMAND = COMMAND_NAMES.sessionSend;
export const WORKSPACE_LIST_COMMAND = COMMAND_NAMES.workspaceList;
export const WORKFLOW_RUN_COMMAND = COMMAND_NAMES.workflowRun;
export const WORKFLOW_APPROVE_COMMAND = COMMAND_NAMES.workflowApprove;
export const WORKFLOW_START_COMMAND = 'workflow.start';
export const MACHINE_LIST_COMMAND = COMMAND_NAMES.machineList;
export const SESSION_RESUME_COMMAND = COMMAND_NAMES.sessionResume;
export const WORKSPACE_STATUS_COMMAND = COMMAND_NAMES.workspaceStatus;

export type CommandName = (typeof COMMAND_NAMES)[keyof typeof COMMAND_NAMES];

export interface SessionOpenArgs {
  readonly provider: string;
  readonly prompt: string;
  readonly cwd?: string;
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
