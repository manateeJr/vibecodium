import { randomUUID } from 'node:crypto';
import type {
  ActionEventPayload,
  EventEnvelope,
  SessionOutputPayload,
  SessionStartedPayload,
  VerifyFailedPayload,
} from '../contracts/events.js';
import type { SubsystemContext } from '../contracts/subsystem.js';
import {
  BASIC_BUILD_TEMPLATE,
  templateStage,
  WORKFLOW_STAGES,
  type WorkflowTemplate,
} from './templates.js';
import {
  runPodmanRootless,
  type PodmanRunRequest,
  type PodmanRunResult,
  type PodmanRunner,
} from './podman.js';
import type {
  WorkflowEngineOptions,
  WorkflowFailurePacket,
  WorkflowResult,
  WorkflowSnapshot,
  WorkflowStage,
  WorkflowStatus,
} from './types.js';
export type {
  WorkflowAdvanceCommand,
  WorkflowApproveCommand,
  WorkflowEngineOptions,
  WorkflowFailurePacket,
  WorkflowResult,
  WorkflowSnapshot,
  WorkflowStage,
  WorkflowStartCommand,
  WorkflowStatus,
} from './types.js';
import {
  booleanField,
  commandObject,
  isReleaseAction,
  requiredWorkflowId,
  stringField,
  workflowIdFromStream,
} from './helpers.js';

type MutableWorkflow = {
  readonly workflow_id: string;
  readonly template: WorkflowTemplate;
  stage: WorkflowStage;
  status: WorkflowStatus;
  approved: boolean;
  approval_denied: boolean;
  approval_request_id: string | null;
  failure_packet: WorkflowFailurePacket | null;
  output_index: number;
};
export class WorkflowEngine {
  private readonly workflows = new Map<string, MutableWorkflow>();
  private readonly templates = new Map<string, WorkflowTemplate>();
  private readonly defaultTemplate: WorkflowTemplate;
  private readonly verifyRunner: PodmanRunner;
  private readonly idFactory: () => string;
  private readonly now: () => string;

  public constructor(
    private readonly context: SubsystemContext,
    options: WorkflowEngineOptions = {},
  ) {
    const configuredTemplates = options.templates ?? [BASIC_BUILD_TEMPLATE];
    if (configuredTemplates.length === 0)
      throw new Error('at least one workflow template is required');
    for (const template of configuredTemplates) this.addTemplate(template);
    this.defaultTemplate = this.templates.get('basic-build') ?? configuredTemplates[0]!;
    this.verifyRunner = options.podmanRunner ?? options.verifyRunner ?? runPodmanRootless;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }
  public register(): void {
    this.context.registerProjector('workflow-engine', (event) => this.project(event), 0);
    this.context.registerListener('workflow-approval', (event) => this.onApproval(event));
    this.context.registerCommand('workflow.start', (command) => this.start(command));
    this.context.registerCommand('workflow.advance', (command) => this.advance(command));
    this.context.registerCommand('workflow.approve', (command) => this.approve(command));
  }

  public start(command: unknown): WorkflowResult {
    const input = commandObject(command);
    const workflowId =
      stringField(input, 'workflow_id') ?? stringField(input, 'id') ?? this.idFactory();
    if (!workflowId.trim()) throw new Error('workflow_id is required');
    if (this.workflows.has(workflowId)) throw new Error(`workflow already exists: ${workflowId}`);
    const templateName = stringField(input, 'template') ?? stringField(input, 'template_name');
    const template = templateName ? this.findTemplate(templateName) : this.defaultTemplate;
    const state = this.newWorkflow(workflowId, template);
    this.workflows.set(workflowId, state);
    try {
      this.context.append(`workflow:${workflowId}`, 'session_started', {
        session_id: workflowId,
        provider: 'workflow',
        prompt: `workflow-template:${template.name}`,
      });
    } catch (error: unknown) {
      this.workflows.delete(workflowId);
      throw error;
    }
    return this.result(state);
  }

  public advance(command: unknown): WorkflowResult {
    const input = commandObject(command);
    const workflowId = requiredWorkflowId(input);
    const state = this.requireWorkflow(workflowId);

    if (state.status === 'released') return this.result(state);
    if (state.status === 'waiting_approval') {
      if (!state.approved) return this.blocked(state, 'release approval is required');
      state.status = 'running';
      state.stage = 'release';
      return this.release(state);
    }

    switch (state.stage) {
      case 'spec':
        return this.completeStage(state, 'spec', 'build');
      case 'build':
        return this.completeStage(state, 'build', 'verify');
      case 'verify':
        return this.verify(state);
      case 'review':
        this.completeStage(state, 'review', 'approve');
        return this.enterApproval(state);
      case 'approve':
        return this.enterApproval(state);
      case 'release':
        return this.release(state);
    }
  }

  public approve(command: unknown): WorkflowResult {
    const input = commandObject(command);
    const workflowId = requiredWorkflowId(input);
    const state = this.requireWorkflow(workflowId);
    if (state.status !== 'waiting_approval' || !state.approval_request_id) {
      throw new Error(`workflow is not waiting for approval: ${workflowId}`);
    }
    const requestId = stringField(input, 'request_id') ?? state.approval_request_id;
    if (requestId !== state.approval_request_id)
      throw new Error('approval request_id does not match');
    const approved = booleanField(input, 'approved') ?? true;
    const reason = stringField(input, 'reason');
    const payload: ActionEventPayload = {
      request_id: requestId,
      action: 'workflow.release',
      scope: { workflow_id: workflowId, template: state.template.name },
      ...(reason ? { reason } : {}),
    };
    this.context.append(
      `action:${requestId}`,
      approved ? 'action_approved' : 'action_denied',
      payload,
    );
    if (!approved) return this.blocked(state, reason ?? 'release approval was denied');
    return this.advance({ workflow_id: workflowId });
  }

  public get(workflowId: string): WorkflowSnapshot | undefined {
    const state = this.workflows.get(workflowId);
    return state ? this.snapshot(state) : undefined;
  }

  private addTemplate(template: WorkflowTemplate): void {
    if (!template.name.trim()) throw new Error('workflow template name is required');
    if (!template.image.trim()) throw new Error(`template ${template.name} image is required`);
    if (template.stages.length !== WORKFLOW_STAGES.length) {
      throw new Error(`template ${template.name} must define all workflow stages`);
    }
    for (const [index, stage] of WORKFLOW_STAGES.entries()) {
      const definition = template.stages[index];
      if (!definition || definition.stage !== stage) {
        throw new Error(`template ${template.name} stages must follow the workflow order`);
      }
    }
    if (this.templates.has(template.name))
      throw new Error(`duplicate workflow template: ${template.name}`);
    this.templates.set(template.name, template);
  }

  private findTemplate(name: string): WorkflowTemplate {
    const template = this.templates.get(name);
    if (!template) throw new Error(`unknown workflow template: ${name}`);
    return template;
  }

  private newWorkflow(workflowId: string, template: WorkflowTemplate): MutableWorkflow {
    return {
      workflow_id: workflowId,
      template,
      stage: 'spec',
      status: 'running',
      approved: false,
      approval_denied: false,
      approval_request_id: null,
      failure_packet: null,
      output_index: -1,
    };
  }

  private completeStage(
    state: MutableWorkflow,
    completed: WorkflowStage,
    next: WorkflowStage,
  ): WorkflowResult {
    state.stage = next;
    this.output(state, `stage_complete:${completed}`);
    return this.result(state);
  }

  private verify(state: MutableWorkflow): WorkflowResult {
    const definition = templateStage(state.template, 'verify');
    const command = definition.command ?? ['node', '-e', 'process.stdout.write("verified")'];
    let verification: PodmanRunResult;
    try {
      const request: PodmanRunRequest = {
        image: state.template.image,
        command,
      };
      verification = this.verifyRunner(request);
    } catch (error: unknown) {
      verification = {
        ok: false,
        exit_code: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!verification.ok) return this.failedVerification(state, command, verification);
    state.stage = 'review';
    this.output(state, 'stage_complete:verify');
    return this.result(state);
  }

  private failedVerification(
    state: MutableWorkflow,
    command: readonly string[],
    verification: PodmanRunResult,
  ): WorkflowResult {
    const error =
      verification.error ||
      verification.stderr.trim() ||
      `sandbox exited with code ${verification.exit_code ?? 'unknown'}`;
    const errorClass =
      verification.error_code === 'ENOENT' ? 'podman_unavailable' : 'sandbox_verify_failed';
    const packet: WorkflowFailurePacket = {
      kind: 'workflow_failure',
      workflow_id: state.workflow_id,
      template: state.template.name,
      stage: 'verify',
      command,
      image: state.template.image,
      exit_code: verification.exit_code,
      stdout: verification.stdout,
      stderr: verification.stderr,
      error,
      error_class: errorClass,
      retry_stage: 'build',
      ts: this.now(),
    };
    state.failure_packet = packet;
    state.stage = 'build';
    state.status = 'running';
    this.context.append(`workflow:${state.workflow_id}`, 'verify_failed', {
      stage: 'verify',
      error,
      session_id: state.workflow_id,
      error_class: errorClass,
    });
    return this.result(state);
  }

  private enterApproval(state: MutableWorkflow): WorkflowResult {
    state.stage = 'approve';
    state.status = 'waiting_approval';
    state.approved = false;
    state.approval_denied = false;
    const requestId = this.idFactory();
    if (!requestId.trim()) throw new Error('approval request_id is required');
    state.approval_request_id = requestId;
    const payload: ActionEventPayload = {
      request_id: requestId,
      action: 'workflow.release',
      scope: { workflow_id: state.workflow_id, template: state.template.name },
      reason: 'verified workflow is ready for release',
    };
    this.context.append(`action:${requestId}`, 'action_requested', payload);
    return this.blocked(state, 'release approval is required');
  }

  private release(state: MutableWorkflow): WorkflowResult {
    if (!state.approved) return this.blocked(state, 'release approval is required');
    state.stage = 'release';
    this.output(state, 'stage_complete:release');
    this.context.append(`workflow:${state.workflow_id}`, 'merge_to_main', {
      branch: `workflow/${state.workflow_id}`,
      commit_sha: state.workflow_id,
    });
    this.context.append(`workflow:${state.workflow_id}`, 'session_complete', {
      session_id: state.workflow_id,
      provider: 'workflow',
    });
    state.status = 'released';
    return this.result(state);
  }

  private output(state: MutableWorkflow, text: string): void {
    state.output_index += 1;
    this.context.append(`workflow:${state.workflow_id}`, 'session_output', {
      session_id: state.workflow_id,
      index: state.output_index,
      text,
    });
  }

  private project(event: EventEnvelope): void {
    switch (event.type) {
      case 'session_started':
        this.projectStarted(event, event.payload as SessionStartedPayload);
        return;
      case 'session_output':
        this.projectOutput(event.payload as SessionOutputPayload);
        return;
      case 'verify_failed':
        this.projectFailure(event, event.payload as VerifyFailedPayload);
        return;
      case 'action_requested':
        this.projectAction(event.payload as ActionEventPayload, false);
        return;
      case 'action_approved':
        this.projectAction(event.payload as ActionEventPayload, true);
        return;
      case 'action_denied':
        this.projectAction(event.payload as ActionEventPayload, false, true);
        return;
      case 'merge_to_main':
        this.projectMerge(event.stream_id);
        return;
      case 'session_complete':
        this.projectComplete(event.stream_id);
        return;
      default:
        return;
    }
  }

  private projectStarted(event: EventEnvelope, payload: SessionStartedPayload): void {
    if (!event.stream_id.startsWith('workflow:') || this.workflows.has(payload.session_id)) return;
    const templateName = payload.prompt.startsWith('workflow-template:')
      ? payload.prompt.slice('workflow-template:'.length)
      : this.defaultTemplate.name;
    const template = this.templates.get(templateName) ?? this.defaultTemplate;
    this.workflows.set(payload.session_id, this.newWorkflow(payload.session_id, template));
  }

  private projectOutput(payload: SessionOutputPayload): void {
    const state = this.workflows.get(payload.session_id);
    if (!state) return;
    state.output_index = Math.max(state.output_index, payload.index);
    const completed = payload.text.match(
      /^stage_complete:(spec|build|verify|review|release)$/,
    )?.[1] as WorkflowStage | undefined;
    if (!completed) return;
    const completedIndex = WORKFLOW_STAGES.indexOf(completed);
    const next = WORKFLOW_STAGES[completedIndex + 1];
    if (next) state.stage = next;
  }

  private projectFailure(event: EventEnvelope, payload: VerifyFailedPayload): void {
    const workflowId = payload.session_id ?? workflowIdFromStream(event.stream_id);
    if (!workflowId) return;
    const state = this.workflows.get(workflowId);
    if (!state) return;
    state.stage = 'build';
    state.status = 'running';
    if (!state.failure_packet) {
      state.failure_packet = {
        kind: 'workflow_failure',
        workflow_id: workflowId,
        template: state.template.name,
        stage: 'verify',
        command: [],
        image: state.template.image,
        exit_code: null,
        stdout: '',
        stderr: payload.error,
        error: payload.error,
        error_class: payload.error_class ?? 'sandbox_verify_failed',
        retry_stage: 'build',
        ts: event.ts,
      };
    }
  }

  private projectAction(payload: ActionEventPayload, approved: boolean, denied = false): void {
    if (!isReleaseAction(payload.action)) return;
    const workflowId = payload.scope.workflow_id;
    const state = workflowId
      ? this.workflows.get(workflowId)
      : this.findByRequest(payload.request_id);
    if (!state || state.status === 'released') return;
    if (state.approval_request_id && state.approval_request_id !== payload.request_id) return;
    if (!state.approval_request_id) state.approval_request_id = payload.request_id;
    state.approved = approved && !denied;
    state.approval_denied = denied;
    state.status = 'waiting_approval';
    state.stage = 'approve';
  }

  private onApproval(event: EventEnvelope): void {
    if (event.type === 'action_approved') {
      this.projectAction(event.payload as ActionEventPayload, true);
      return;
    }
    if (event.type === 'action_denied')
      this.projectAction(event.payload as ActionEventPayload, false, true);
  }

  private findByRequest(requestId: string): MutableWorkflow | undefined {
    for (const state of this.workflows.values()) {
      if (state.approval_request_id === requestId) return state;
    }
    return undefined;
  }

  private requireWorkflow(workflowId: string): MutableWorkflow {
    const state = this.workflows.get(workflowId);
    if (!state) throw new Error(`unknown workflow: ${workflowId}`);
    return state;
  }

  private projectMerge(streamId: string): void {
    const state = this.workflows.get(workflowIdFromStream(streamId) ?? '');
    if (!state) return;
    state.stage = 'release';
    state.status = 'released';
  }

  private projectComplete(streamId: string): void {
    const state = this.workflows.get(workflowIdFromStream(streamId) ?? '');
    if (state) state.status = 'released';
  }

  private snapshot(state: MutableWorkflow): WorkflowSnapshot {
    return {
      workflow_id: state.workflow_id,
      template: state.template.name,
      stage: state.stage,
      status: state.status,
      approved: state.approved,
      approval_request_id: state.approval_request_id,
      failure_packet: state.failure_packet,
    };
  }

  private result(state: MutableWorkflow): WorkflowResult {
    return {
      ...this.snapshot(state),
      blocked: state.status === 'waiting_approval' && !state.approved,
      reason:
        state.status === 'waiting_approval' && !state.approved
          ? 'release approval is required'
          : null,
    };
  }

  private blocked(state: MutableWorkflow, reason: string): WorkflowResult {
    return { ...this.snapshot(state), blocked: true, reason };
  }
}
