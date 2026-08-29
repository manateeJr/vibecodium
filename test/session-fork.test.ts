import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { CommandHandler, EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { SessionSubsystem } from '../src/session/index.js';

class TestContext implements SubsystemContext {
  public readonly events: EventEnvelope[] = [];
  public readonly commands = new Map<string, CommandHandler>();
  private readonly projectors = new Map<string, EventHandler>();
  private nextSequence = 1;

  public registerProjector(name: string, onEvent: EventHandler, from_seq = 0): void {
    this.projectors.set(name, onEvent);
    for (const event of this.events) if (event.seq > from_seq) onEvent(event);
  }

  public registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  public registerListener(): void {}

  public subscribe(): () => void {
    return () => undefined;
  }

  public append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number {
    return this.appendRaw(stream_id, type, payload);
  }

  public appendRaw(stream_id: string, type: string, payload: unknown): number {
    const event = {
      stream_id,
      seq: this.nextSequence,
      type: type as EventKind,
      payload: payload as EventPayload,
      ts: new Date(this.nextSequence * 1000).toISOString(),
    } as EventEnvelope;
    this.nextSequence += 1;
    this.events.push(event);
    for (const projector of this.projectors.values()) projector(event);
    return event.seq;
  }
}

test('session.list filters, caps, sorts, and tracks terminal statuses', () => {
  const context = new TestContext();
  context.append('session:old', 'session_started', {
    session_id: 'old',
    provider: 'omp',
    prompt: 'old prompt',
    project: 'alpha',
    cwd: '/alpha',
  });
  context.append('session:done', 'session_started', {
    session_id: 'done',
    provider: 'codex',
    prompt: 'done prompt',
    project: 'alpha',
  });
  context.append('session:done', 'session_complete', {
    session_id: 'done',
    provider: 'codex',
  });
  context.append('session:failed', 'session_started', {
    session_id: 'failed',
    provider: 'omp',
    prompt: 'failed prompt',
    project: 'alpha',
  });
  context.append('session:failed', 'verify_failed', {
    session_id: 'failed',
    stage: 'session',
    error: 'failed',
  });
  context.appendRaw('session:stopped', 'session_started', {
    session_id: 'stopped',
    provider: 'omp',
    prompt: 'stopped prompt',
    project: 'beta',
  });
  context.appendRaw('session:stopped', 'session_stop', { session_id: 'stopped' });
  const subsystem = new SessionSubsystem();
  subsystem.register(context);
  const list = context.commands.get(COMMAND_NAMES.sessionList);
  assert.ok(list);

  const alpha = list({ project: 'alpha', limit: 2 }) as { sessions: readonly unknown[] };
  assert.deepEqual(
    alpha.sessions.map((session) => (session as { session_id: string; status: string }).session_id),
    ['failed', 'done'],
  );
  assert.equal(
    (list({ project: 'alpha' }) as { sessions: readonly { status: string }[] }).sessions[0]?.status,
    'failed',
  );
  assert.equal(
    (list({ project: 'beta' }) as { sessions: readonly { status: string }[] }).sessions[0]?.status,
    'stopped',
  );
  assert.equal(
    (list({ project: 'alpha' }) as { sessions: readonly { status: string }[] }).sessions[1]?.status,
    'done',
  );
});

test('session.fork copies the source store without mutating it and emits lineage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-session-fork-'));
  const sourceId = 'source-session';
  const forkId = 'fork-session';
  const sourceFile = path.join(root, sourceId, 'transcript.jsonl');
  const transcript = '{"role":"user","text":"keep this byte-for-byte"}\n';
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, transcript);
  const context = new TestContext();
  context.append('session:source-session', 'session_started', {
    session_id: sourceId,
    provider: 'omp',
    prompt: 'resume this',
    project: 'alpha',
    cwd: '/workspace',
  });
  const subsystem = new SessionSubsystem({
    sessionStorageRoot: root,
    idFactory: () => forkId,
  });
  subsystem.register(context);

  try {
    const before = fs.readFileSync(sourceFile);
    const result = await subsystem.fork({ session_id: sourceId });
    assert.deepEqual(result, {
      new_session_id: forkId,
      provider: 'omp',
      continue_command: `omp --resume ${forkId} --session-dir ${path.join(root, forkId)}`,
    });
    assert.deepEqual(fs.readFileSync(sourceFile), before);
    assert.equal(fs.readFileSync(path.join(root, forkId, 'transcript.jsonl'), 'utf8'), transcript);
    assert.deepEqual(context.events.find((event) => event.type === 'session_forked')?.payload, {
      session_id: forkId,
      source_session_id: sourceId,
      provider: 'omp',
    });
    const forked = subsystem
      .list({ project: 'alpha' })
      .sessions.find((session) => session.session_id === forkId);
    assert.equal(forked?.status, 'live');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
