import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateCreateOptions,
  SubstrateKey,
  SubstrateOutputListener,
  SubstrateSessionInfo,
} from '../src/contracts/substrate-contract.js';
import { ompHarnessPlugin } from '../src/provider/omp-harness-plugin.js';
import { PersistentSessionWorker } from '../src/server/session-worker.js';
import { SessionSubsystem } from '../src/session/index.js';
import { harnessRefFromTranscriptPath } from '../src/session/transcript-ref.js';
import { SessionTable } from '../src/session/session-table.js';

class TestContext implements SubsystemContext {
  public readonly events: EventEnvelope[] = [];
  public readonly commands = new Map<string, (command: unknown) => unknown>();
  private nextSequence = 1;
  private readonly projectors = new Map<string, EventHandler>();

  public registerProjector(name: string, onEvent: EventHandler, from_seq = 0): void {
    this.projectors.set(name, onEvent);
    for (const event of this.events) if (event.seq > from_seq) onEvent(event);
  }

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
      seq: this.nextSequence++,
      type,
      payload,
      ts: new Date(this.nextSequence * 1000).toISOString(),
    };
    this.events.push(event);
    for (const projector of this.projectors.values()) projector(event);
    return event.seq;
  }
}

class TestSubstrate implements SubstrateClient {
  public readonly created: Array<{ name: string; argv: readonly string[] }> = [];
  public readonly sentKeys: Array<{ name: string; key: SubstrateKey }> = [];
  public readonly writes: Array<{ name: string; text: string }> = [];
  public readonly operations: string[] = [];
  public readonly liveNames = new Set<string>();

  public async createSession(
    name: string,
    argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo> {
    void options;
    this.created.push({ name, argv });
    this.liveNames.add(name);
    return { name, live: true };
  }

  public async attach(name: string): Promise<SubstrateAttachment> {
    return { name, detach: async () => undefined };
  }

  public async write(name: string, bytes: Uint8Array): Promise<void> {
    this.operations.push('write');
    this.writes.push({ name, text: new TextDecoder().decode(bytes) });
  }

  public async sendKey(name: string, key: SubstrateKey): Promise<void> {
    this.operations.push(`key:${key}`);
    this.sentKeys.push({ name, key });
  }

  public onOutput(listener: SubstrateOutputListener): () => void {
    void listener;
    return () => undefined;
  }

  public async isLive(name: string): Promise<boolean> {
    return this.liveNames.has(name);
  }

  public async kill(name: string): Promise<void> {
    this.liveNames.delete(name);
  }

  public async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    return [...this.liveNames].map((name) => ({ name, live: true }));
  }
}

class DeadOnCreateSubstrate extends TestSubstrate {
  private deadName: string | undefined;

  public override async createSession(
    name: string,
    argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo> {
    const created = await super.createSession(name, argv, options);
    this.deadName = name;
    this.liveNames.delete(name);
    return created;
  }

  public override async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    return this.deadName === undefined ? [] : [{ name: this.deadName, live: false }];
  }
}

class BlockingSubstrate extends TestSubstrate {
  private readonly createGate: Promise<void>;
  private releaseCreate!: () => void;
  private resolveCreateStarted!: () => void;
  public readonly createStarted: Promise<void>;

  public constructor() {
    super();
    this.createGate = new Promise((resolve) => {
      this.releaseCreate = resolve;
    });
    this.createStarted = new Promise((resolve) => {
      this.resolveCreateStarted = resolve;
    });
  }

  public release(): void {
    this.releaseCreate();
  }

  public override async createSession(
    name: string,
    argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo> {
    this.resolveCreateStarted();
    await this.createGate;
    return super.createSession(name, argv, options);
  }
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('transcript ref parser handles real and malformed filenames', () => {
  assert.equal(
    harnessRefFromTranscriptPath(
      '/tmp/omp/2026-08-30T20-43-53-324Z_01a0546a-146c-7000-9032-3674b9943f50.jsonl',
    ),
    '01a0546a-146c-7000-9032-3674b9943f50',
  );
  assert.equal(
    harnessRefFromTranscriptPath('/tmp/omp/2026-08-30T20-43-53-324Z_ref_with_underscores.jsonl'),
    'ref_with_underscores',
  );
  assert.equal(harnessRefFromTranscriptPath('/tmp/omp/no-underscore.jsonl'), undefined);
  assert.deepEqual(
    ompHarnessPlugin.launchArgv({
      sessionId: 'session-id',
      cwd: '/workspace',
      resumeRef: 'session-id',
      transcriptPath:
        '/tmp/omp/2026-08-30T20-43-53-324Z_01a0546a-146c-7000-9032-3674b9943f50.jsonl',
    }),
    ['omp', '--resume', '01a0546a-146c-7000-9032-3674b9943f50'],
  );
});

test('failed cold resume remains resumable and surfaces the undelivered prompt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-resume-failed-'));
  const context = new TestContext();
  const substrate = new DeadOnCreateSubstrate();
  const table = new SessionTable({ filename: ':memory:' });
  const sessionId = 'failed-resume-session';
  table.upsert({
    sessionId,
    provider: 'omp',
    harnessRef: 'stored-ref',
    substrateName: `substrate-${sessionId}`,
    transcriptPath: path.join(
      root,
      sessionId,
      '2026-08-30T20-43-53-324Z_01a0546a-146c-7000-9032-3674b9943f50.jsonl',
    ),
    storageDir: path.join(root, sessionId),
    state: 'resumable',
    updatedAt: '2026-08-30T00:00:00.000Z',
  });
  context.append(`session:${sessionId}`, 'session_started', {
    session_id: sessionId,
    provider: 'omp',
    prompt: 'old prompt',
  });
  const subsystem = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    await subsystem.reconcile();
    await assert.rejects(
      async () => await subsystem.send({ session_id: sessionId, prompt: 'retry this prompt' }),
      /resume-failed: .*undelivered prompt: retry this prompt/,
    );
    assert.equal(table.get(sessionId)?.state, 'resumable');
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'session_state' &&
          (event.payload as EventPayload<'session_state'>).state === 'live',
      ),
      false,
    );
    const failure = context.events.find(
      (event) =>
        event.type === 'verify_failed' &&
        (event.payload as EventPayload<'verify_failed'>).session_id === sessionId,
    );
    assert.ok(failure);
    assert.equal(failure.type, 'verify_failed');
    const failurePayload = failure.payload as EventPayload<'verify_failed'>;
    assert.equal(failurePayload.prompt, 'retry this prompt');
    assert.match(failurePayload.error, /undelivered prompt: retry this prompt/);
    assert.deepEqual(substrate.created[0]?.argv, [
      'omp',
      '--session-dir',
      path.join(root, sessionId),
      '--resume',
      '01a0546a-146c-7000-9032-3674b9943f50',
      'retry this prompt',
    ]);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bare ensure-live relaunches without injecting a prompt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-resume-'));
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert({
    sessionId: 'resume-session',
    provider: 'omp',
    harnessRef: 'omp-ref',
    substrateName: 'substrate-resume-session',
    transcriptPath: path.join(root, 'resume-session', 'session.jsonl'),
    storageDir: path.join(root, 'resume-session'),
    state: 'resumable',
    updatedAt: '2026-08-30T00:00:00.000Z',
  });
  context.append('session:resume-session', 'session_started', {
    session_id: 'resume-session',
    provider: 'omp',
    prompt: 'old prompt',
    cwd: '/workspace',
  });
  const subsystem = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    const ensureLive = context.commands.get('session.ensure_live');
    assert.ok(ensureLive);
    assert.deepEqual(await ensureLive({ session_id: 'resume-session' }), {
      state: 'live',
      substrate_name: 'substrate-resume-session',
    });
    assert.deepEqual(substrate.created[0]?.argv, [
      'omp',
      '--session-dir',
      path.join(root, 'resume-session'),
      '--resume',
      'omp-ref',
    ]);
    assert.deepEqual(substrate.sentKeys, []);
    assert.deepEqual(substrate.writes, []);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('warm persistent sends use PTY injection instead of relaunch argv', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-warm-send-'));
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const table = new SessionTable({ filename: ':memory:' });
  const subsystem = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    idFactory: () => 'warm-session',
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    const opened = await subsystem.open({ provider: 'omp', prompt: 'first prompt' });
    const transcriptPath = table.get(opened.session_id)?.transcriptPath;
    assert.ok(transcriptPath);
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
      })}\n` +
        `${JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stopReason: 'stop',
          },
        })}\n`,
    );
    await subsystem.reapIdle();
    const beforeKeys = substrate.sentKeys.length;
    const beforeWrites = substrate.writes.length;
    const sent = await subsystem.send({ session_id: opened.session_id, prompt: 'warm prompt' });
    await nextImmediate();
    assert.deepEqual(sent, { stream_id: 'session:warm-session', turn: 2 });
    assert.equal(substrate.created.length, 1);
    assert.deepEqual(
      substrate.sentKeys.slice(beforeKeys).map((entry) => entry.key),
      ['ctrl_u', 'enter'],
    );
    assert.deepEqual(substrate.writes.slice(beforeWrites), [
      { name: 'substrate-warm-session', text: '\x1b[200~warm prompt\x1b[201~' },
    ]);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent cold sends reject while the first relaunch is in flight', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-cold-send-race-'));
  const context = new TestContext();
  const substrate = new BlockingSubstrate();
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert({
    sessionId: 'cold-session',
    provider: 'omp',
    harnessRef: 'omp-ref',
    substrateName: 'substrate-cold-session',
    transcriptPath: path.join(root, 'cold-session', 'session.jsonl'),
    storageDir: path.join(root, 'cold-session'),
    state: 'resumable',
    updatedAt: '2026-08-30T00:00:00.000Z',
  });
  const subsystem = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    const first = subsystem.send({ session_id: 'cold-session', prompt: 'first cold prompt' });
    assert.ok(first instanceof Promise);
    await substrate.createStarted;
    assert.throws(
      () => subsystem.send({ session_id: 'cold-session', prompt: 'racing cold prompt' }),
      /session is busy/,
    );
    substrate.release();
    assert.deepEqual(await first, {
      stream_id: 'session:cold-session',
      turn: 1,
    });
    assert.deepEqual(substrate.created[0]?.argv, [
      'omp',
      '--session-dir',
      path.join(root, 'cold-session'),
      '--resume',
      'omp-ref',
      'first cold prompt',
    ]);
  } finally {
    substrate.release();
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('warm mid-turn sends inject the prompt without advancing the turn', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-steering-send-'));
  const substrate = new TestSubstrate();
  const worker = new PersistentSessionWorker({
    substrate,
    plugin: ompHarnessPlugin,
    sessionId: 'steering-session',
    streamId: 'session:steering-session',
    provider: 'omp',
    substrateName: 'substrate-steering-session',
    storageDir: path.join(root, 'storage'),
    transcriptPath: path.join(root, 'storage', 'session.jsonl'),
    append: () => 1,
  });
  try {
    await worker.start('initial prompt');
    assert.equal(worker.isBusy, true);
    const prompt = 'line one\nline two\t\x1b[31mred\x07';
    assert.equal(await worker.sendPrompt(prompt), 0);
    assert.deepEqual(
      substrate.sentKeys.map((entry) => entry.key),
      ['ctrl_u', 'enter'],
    );
    assert.deepEqual(substrate.operations, ['key:ctrl_u', 'write', 'key:enter']);
    assert.deepEqual(substrate.writes, [
      { name: 'substrate-steering-session', text: `\x1b[200~${prompt}\x1b[201~` },
    ]);
  } finally {
    await worker.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistent sends before attach reject as not live', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-not-live-send-'));
  const worker = new PersistentSessionWorker({
    substrate: new TestSubstrate(),
    plugin: ompHarnessPlugin,
    sessionId: 'not-live-session',
    streamId: 'session:not-live-session',
    provider: 'omp',
    substrateName: 'substrate-not-live-session',
    storageDir: path.join(root, 'storage'),
    transcriptPath: path.join(root, 'storage', 'session.jsonl'),
    append: () => 1,
  });
  try {
    await assert.rejects(() => worker.sendPrompt('prompt'), /persistent session is not live/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
