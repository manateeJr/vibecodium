import type { PodmanRunner } from './podman.js';
import type { WorkflowTemplate } from './templates.js';

export type WorkflowStage = 'spec' | 'build' | 'verify' | 'review' | 'approve' | 'release';
export type WorkflowStatus = 'running' | 'waiting_approval' | 'released';

export interface WorkflowFailurePacket {
  readonly kind: 'workflow_failure';
  readonly workflow_id: string;
  readonly template: string;
  readonly stage: 'verify';
  readonly command: readonly string[];
  readonly image: string;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string;
  readonly error_class: string;
  readonly retry_stage: 'build';
  readonly ts: string;
}

export interface WorkflowSnapshot {
  readonly workflow_id: string;
  readonly template: string;
  readonly stage: WorkflowStage;
  readonly status: WorkflowStatus;
  readonly approved: boolean;
  readonly approval_request_id: string | null;
  readonly failure_packet: WorkflowFailurePacket | null;
}

export interface WorkflowResult extends WorkflowSnapshot {
  readonly blocked: boolean;
  readonly reason: string | null;
}

export interface WorkflowStartCommand {
  readonly workflow_id?: string;
  readonly id?: string;
  readonly template?: string;
  readonly template_name?: string;
}

export interface WorkflowAdvanceCommand {
  readonly workflow_id: string;
  readonly id?: string;
}

export interface WorkflowApproveCommand {
  readonly workflow_id: string;
  readonly id?: string;
  readonly request_id?: string;
  readonly approved?: boolean;
  readonly reason?: string;
}

export interface WorkflowEngineOptions {
  readonly templates?: readonly WorkflowTemplate[];
  readonly podmanRunner?: PodmanRunner;
  readonly verifyRunner?: PodmanRunner;
  readonly idFactory?: () => string;
  readonly now?: () => string;
}
