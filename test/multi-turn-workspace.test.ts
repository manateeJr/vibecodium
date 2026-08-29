import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import type { ChildProcessSpawner } from '../src/provider/cli-provider.js';
import { CodexProvider } from '../src/provider/codex-provider.js';
import { OmpProvider } from '../src/provider/omp-provider.js';
import { SessionSubsystem } from '../src/session/index.js';
import { createWorkspaceSubsystem } from '../src/workspace/index.js';

class FakeWorker extends EventEmitter {
  public connected = true;
  public killed = false;
  public readonly messages: unknown[] = [];

  public send(message: unknown, callback?: (error?: Error | null) => void): boolean {
    this.messages.push(message);
    callback?.();
    return true;
  }

  public kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }
}

class TestContext implements SubsystemContext {
  public readonly events: EventEnvelope[] = [];
  public readonly commands = new Map<string, (command: unknown) => unknown>();
  private nextSequence = 1;

  public registerProjector(): void {}

  public registerCommand(name: string, handler: (command: unknown) => unknown): void {
    this.commands.set(name, handler);
  }

  public registerListener(): void {}

  public subscribe(): () => void {
    return () => undefined;
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
    return event.seq;
  }
}

class MockChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public killed = false;
  public exitCode: number | null = null;

  public kill(): boolean {
    this.killed = true;
    this.emit('close', null, 'SIGTERM');
    return true;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

function spawnSpy(calls: SpawnCall[], children: MockChild[]): ChildProcessSpawner {
  return (command, args, options) => {
    const child = new MockChild();
    children.push(child);
    calls.push({ command, args, options });
    return child as unknown as ChildProcess;
  };
}

test('SessionSubsystem keeps a conversation active across turns', async () => {
  const context = new TestContext();
  const worker = new FakeWorker();
  const subsystem = new SessionSubsystem({
    idFactory: () => 'session-1',
    fork: () => worker as unknown as ChildProcess,
  });
  subsystem.register(context);

  const opened = await subsystem.open({
    provider: 'fake',
    prompt: 'first prompt',
    cwd: '/tmp/project',
    project: 'vibecodium',
  });
  assert.deepEqual(context.events[0]?.payload, {
    session_id: opened.session_id,
    provider: 'fake',
    prompt: 'first prompt',
    cwd: '/tmp/project',
    project: 'vibecodium',
  });
  assert.deepEqual(worker.messages[0], {
    type: 'start',
    session_id: opened.session_id,
    stream_id: opened.stream_id,
    provider: 'fake',
    prompt: 'first prompt',
    cwd: '/tmp/project',
  });
  assert.throws(
    () => subsystem.send({ session_id: opened.session_id, prompt: 'too soon' }),
    /session is busy/,
  );

  worker.emit('message', {
    type: 'event',
    stream_id: opened.stream_id,
    event_type: 'session_output',
    payload: { session_id: opened.session_id, index: 0, text: 'first output' },
  });
  worker.emit('message', {
    type: 'event',
    stream_id: opened.stream_id,
    event_type: 'turn_complete',
    payload: { session_id: opened.session_id, turn: 1 },
  });

  assert.deepEqual(subsystem.send({ session_id: opened.session_id, prompt: 'second prompt' }), {
    stream_id: opened.stream_id,
    turn: 2,
  });
  assert.deepEqual(worker.messages[1], {
    type: 'turn',
    stream_id: opened.stream_id,
    prompt: 'second prompt',
  });
  assert.deepEqual(context.events.at(-1)?.payload, {
    session_id: opened.session_id,
    turn: 2,
    text: 'second prompt',
  });
  assert.throws(
    () => subsystem.send({ session_id: opened.session_id, prompt: 'busy again' }),
    /session is busy/,
  );

  worker.emit('message', {
    type: 'event',
    stream_id: opened.stream_id,
    event_type: 'turn_complete',
    payload: { session_id: opened.session_id, turn: 2 },
  });
  assert.deepEqual(await subsystem.stop({ session_id: opened.session_id }), { stopped: true });
  assert.deepEqual(context.events.at(-1)?.payload, {
    session_id: opened.session_id,
    provider: 'fake',
  });
  assert.deepEqual(worker.messages.at(-1), { type: 'stop', stream_id: opened.stream_id });
  assert.throws(
    () => subsystem.send({ session_id: opened.session_id, prompt: 'after stop' }),
    /session not found/,
  );
});

test('SessionSubsystem keeps a failed turn retryable', async () => {
  const context = new TestContext();
  const worker = new FakeWorker();
  const subsystem = new SessionSubsystem({
    idFactory: () => 'session-error',
    fork: () => worker as unknown as ChildProcess,
  });
  subsystem.register(context);
  const opened = await subsystem.open({ provider: 'fake', prompt: 'first' });

  worker.emit('message', {
    type: 'error',
    stream_id: opened.stream_id,
    message: 'provider failed',
  });
  assert.equal(context.events.at(-1)?.type, 'verify_failed');
  assert.deepEqual(subsystem.send({ session_id: opened.session_id, prompt: 'retry' }), {
    stream_id: opened.stream_id,
    turn: 2,
  });
  await subsystem.stop({ session_id: opened.session_id });
});

test('Providers build resumable argv, environment, and cwd options', async () => {
  const calls: SpawnCall[] = [];
  const children: MockChild[] = [];
  const spawn = spawnSpy(calls, children);
  const omp = new OmpProvider({ spawn });
  const codex = new CodexProvider({ spawn });
  const sessions = [
    await omp.spawn({ sessionId: 'omp-1', prompt: 'hello', cwd: '/workspace' }),
    await omp.spawn({
      sessionId: 'omp-1',
      prompt: 'again',
      cwd: '/workspace',
      storageDir: '/tmp/omp-session',
      resume: true,
    }),
    await codex.spawn({ sessionId: 'codex-1', prompt: 'hello', cwd: '/workspace' }),
    await codex.spawn({
      sessionId: 'codex-1',
      prompt: 'again',
      cwd: '/workspace',
      storageDir: '/tmp/codex-session',
      resume: true,
    }),
  ];

  assert.deepEqual(calls[0]?.args, ['--print', '--mode', 'text', '--', 'hello']);
  assert.deepEqual(calls[1]?.args, [
    '--print',
    '--mode',
    'text',
    '--session-dir',
    '/tmp/omp-session',
    '--continue',
    '--',
    'again',
  ]);
  assert.deepEqual(calls[2]?.args, ['exec', '--json', '--', 'hello']);
  assert.deepEqual(calls[3]?.args, ['exec', 'resume', '--last', '--json', '--', 'again']);
  assert.equal(calls[0]?.options.cwd, '/workspace');
  assert.equal(calls[1]?.options.cwd, '/workspace');
  assert.equal(calls[2]?.options.cwd, '/workspace');
  assert.equal(calls[3]?.options.cwd, '/workspace');
  assert.equal(calls[0]?.options.env, undefined);
  assert.equal(calls[2]?.options.env, undefined);
  assert.equal(calls[3]?.options.env?.CODEX_HOME, '/tmp/codex-session');
  assert.equal(
    calls.some(({ args }) => args.includes('--no-session')),
    false,
  );
  assert.equal(
    calls.some(({ args }) => args.includes('--ephemeral')),
    false,
  );

  await omp.stop(sessions[0]!);
  await omp.stop(sessions[1]!);
  await codex.stop(sessions[2]!);
  await codex.stop(sessions[3]!);
});

test('workspace.list returns non-hidden directories from configured roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-workspace-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-workspace-'));
  try {
    fs.mkdirSync(path.join(root, 'zeta'));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, 'not-a-directory'), 'file');
    fs.mkdirSync(path.join(secondRoot, 'alpha'));
    const commands = new Map<string, (command: unknown) => unknown>();
    createWorkspaceSubsystem({ roots: [root, root, secondRoot, '/does/not/exist'] }).register({
      registerCommand(name: string, handler: CommandHandler) {
        commands.set(name, handler);
      },
    } as unknown as SubsystemContext);

    assert.deepEqual(commands.get(COMMAND_NAMES.workspaceList)?.({}), {
      workspaces: [
        { name: 'alpha', path: path.join(secondRoot, 'alpha') },
        { name: 'zeta', path: path.join(root, 'zeta') },
      ],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});
