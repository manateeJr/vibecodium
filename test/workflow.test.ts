import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import {
  BASIC_BUILD_TEMPLATE,
  WorkflowEngine,
  type WorkflowTemplate,
} from '../src/workflow/index.js';
import {
  runPodmanRootless,
  type PodmanInvoker,
  type PodmanRunResult,
} from '../src/workflow/podman.js';

type RegisteredCommand = (command: unknown) => unknown | Promise<unknown>;

class FakeContext implements SubsystemContext {
  public readonly events: EventEnvelope[] = [];
  public readonly commands = new Map<string, RegisteredCommand>();
  private readonly projectors = new Map<string, EventHandler>();
  private readonly listeners = new Map<string, EventHandler>();
  private readonly subscribers = new Set<EventHandler>();
  private nextSequence = 1;

  public registerProjector(name: string, onEvent: EventHandler, from_seq = 0): void {
    this.projectors.set(name, onEvent);
    for (const event of this.events) if (event.seq > from_seq) onEvent(event);
  }

  public registerCommand(name: string, handler: RegisteredCommand): void {
    this.commands.set(name, handler);
  }
  public registerListener(name: string, handler: EventHandler): void {
    this.listeners.set(name, handler);
  }

  public subscribe(from_seq: number, onEvent: EventHandler): () => void {
    for (const event of this.events) if (event.seq > from_seq) onEvent(event);
    this.subscribers.add(onEvent);
    return () => this.subscribers.delete(onEvent);
  }
  public append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number {
    const event: EventEnvelope<K> = {
      stream_id,
      seq: this.nextSequence,
      type,
      payload,
      ts: new Date(0).toISOString(),
    };
    this.nextSequence += 1;
    this.events.push(event);
    for (const projector of this.projectors.values()) projector(event);
    for (const listener of this.listeners.values()) listener(event);
    for (const subscriber of this.subscribers) subscriber(event);
    return event.seq;
  }
}

function workflowTemplate(name: string, verifyCommand: readonly string[]): WorkflowTemplate {
  return {
    ...BASIC_BUILD_TEMPLATE,
    name,
    stages: BASIC_BUILD_TEMPLATE.stages.map((stage) =>
      stage.stage === 'verify' ? { ...stage, command: verifyCommand } : stage,
    ),
  };
}

function setup(
  runner: (request: { image: string; command: readonly string[] }) => PodmanRunResult,
  templates?: readonly WorkflowTemplate[],
): { context: FakeContext; engine: WorkflowEngine } {
  const context = new FakeContext();
  const ids = ['workflow-1', 'approval-1'];
  const engine = new WorkflowEngine(context, {
    ...(templates ? { templates } : {}),
    podmanRunner: runner,
    idFactory: () => ids.shift() ?? 'unexpected-id',
    now: () => new Date(0).toISOString(),
  });
  engine.register();
  return { context, engine };
}

test('runs basic-build through verify and blocks release until approval', () => {
  const invocations: Array<{ image: string; command: readonly string[] }> = [];
  const { context, engine } = setup((request) => {
    invocations.push(request);
    return { ok: true, exit_code: 0, stdout: 'verified', stderr: '' };
  });

  assert.equal(engine.start({ workflow_id: 'workflow-1' }).stage, 'spec');
  assert.equal(engine.advance({ workflow_id: 'workflow-1' }).stage, 'build');
  assert.equal(engine.advance({ workflow_id: 'workflow-1' }).stage, 'verify');
  assert.equal(engine.advance({ workflow_id: 'workflow-1' }).stage, 'review');
  const gate = engine.advance({ workflow_id: 'workflow-1' });
  assert.equal(gate.stage, 'approve');
  assert.equal(gate.status, 'waiting_approval');
  assert.equal(gate.blocked, true);
  assert.equal(
    context.events.some((event) => event.type === 'merge_to_main'),
    false,
  );
  const requestId = gate.approval_request_id;
  assert.ok(requestId);
  context.append(`action:${requestId}`, 'action_approved', {
    request_id: requestId,
    action: 'workflow.release',
    scope: { workflow_id: 'workflow-1', template: 'basic-build' },
  });
  const released = engine.advance({ workflow_id: 'workflow-1' });
  assert.equal(released.status, 'released');
  assert.equal(released.stage, 'release');
  assert.equal(released.blocked, false);
  assert.equal(context.events.filter((event) => event.type === 'merge_to_main').length, 1);
  assert.equal(context.events.filter((event) => event.type === 'session_complete').length, 1);
  assert.equal(
    context.events.some((event) => event.type === 'action_requested'),
    true,
  );
  assert.equal(
    context.events.some((event) => event.type === 'session_started'),
    true,
  );
});

test('verify failure emits a packet and retries from build', () => {
  let attempt = 0;
  const { context, engine } = setup(() => {
    attempt += 1;
    return attempt === 1
      ? {
          ok: false,
          exit_code: 3,
          stdout: 'partial',
          stderr: 'assertion failed',
        }
      : { ok: true, exit_code: 0, stdout: 'ok', stderr: '' };
  }, [workflowTemplate('failing-once', ['node', '-e', 'process.exit(3)'])]);

  engine.start({ workflow_id: 'workflow-1', template: 'failing-once' });
  engine.advance({ workflow_id: 'workflow-1' });
  engine.advance({ workflow_id: 'workflow-1' });
  const failed = engine.advance({ workflow_id: 'workflow-1' });
  assert.equal(failed.stage, 'build');
  assert.equal(failed.status, 'running');
  assert.equal(failed.failure_packet?.stage, 'verify');
  assert.equal(failed.failure_packet?.retry_stage, 'build');
  assert.equal(failed.failure_packet?.stderr, 'assertion failed');
  assert.equal(context.events.filter((event) => event.type === 'verify_failed').length, 1);

  assert.equal(engine.advance({ workflow_id: 'workflow-1' }).stage, 'verify');
  assert.equal(engine.advance({ workflow_id: 'workflow-1' }).stage, 'review');
  assert.equal(attempt, 2);
});

test('rootless verifier invokes podman with network disabled', () => {
  let executable = '';
  let args: readonly string[] = [];
  const invoke: PodmanInvoker = (name, receivedArgs) => {
    executable = name;
    args = receivedArgs;
    return {
      pid: 1,
      output: [],
      stdout: 'ok',
      stderr: '',
      status: 0,
      signal: null,
    };
  };

  const result = runPodmanRootless(
    { image: 'example/image', command: ['node', '-e', 'true'] },
    invoke,
  );
  assert.equal(result.ok, true);
  assert.equal(executable, 'podman');
  assert.deepEqual(args.slice(0, 5), [
    'run',
    '--network=none',
    '--rm',
    '--userns=keep-id',
    'example/image',
  ]);
  assert.deepEqual(args.slice(5), ['node', '-e', 'true']);
});
