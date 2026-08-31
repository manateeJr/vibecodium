import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { OmpHarnessPlugin } from '../src/provider/omp-harness-plugin.js';
import { PersistentSessionManager } from '../src/session/persistent-session-manager.js';
import { SessionSubsystem } from '../src/session/index.js';
import { SessionTranscriptTailer } from '../src/session/transcript-tailer.js';
import { SessionTable } from '../src/session/session-table.js';
import { abducoBinaryPath } from '../src/substrate/paths.js';

class TestContext implements SubsystemContext {
  public readonly events: EventEnvelope[] = [];
  public readonly commands = new Map<string, (command: unknown) => unknown>();
  private readonly projectors = new Map<string, EventHandler>();
  private nextSequence = 1;

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
  public readonly killedNames: string[] = [];
  public readonly attachedNames: string[] = [];
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
    this.attachedNames.push(name);
    return { name, detach: async () => undefined };
  }

  public async write(name: string, bytes: Uint8Array): Promise<void> {
    this.writes.push({ name, text: new TextDecoder().decode(bytes) });
  }

  public async sendKey(name: string, key: SubstrateKey): Promise<void> {
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
    this.killedNames.push(name);
    this.liveNames.delete(name);
  }

  public async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    return [...this.liveNames].map((name) => ({ name, live: true }));
  }
}

const plugin = new OmpHarnessPlugin();

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('OMP plugin parses fixture records and distinguishes idle stop from error', () => {
  const fixture = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'test/fixtures/omp-transcript.jsonl'),
    'utf8',
  );
  const records = fixture
    .trim()
    .split('\n')
    .map((line) => plugin.parseTranscriptLine(line))
    .filter((record) => record !== null);
  assert.deepEqual(
    records.map((record) => record.kind),
    ['user', 'assistant', 'steering', 'assistant'],
  );
  assert.equal(plugin.idleDetector(records[1]!), true);
  assert.equal(plugin.idleDetector(records[3]!), false);
  const nestedStop = plugin.parseTranscriptLine(
    '{"type":"message","message":{"role":"assistant","stopReason":"stop"}}',
  );
  assert.ok(nestedStop);
  assert.equal(plugin.idleDetector(nestedStop), true);
  assert.equal(plugin.parseTranscriptLine('{broken'), null);
  assert.deepEqual(
    plugin.launchArgv({ sessionId: 'session-1', cwd: '/workspace', storageDir: '/tmp/s1' }),
    ['omp', '--session-dir', '/tmp/s1'],
  );
  assert.deepEqual(
    plugin.launchArgv({
      sessionId: 'session-1',
      cwd: '/workspace',
      storageDir: '/tmp/s1',
      resumeRef: 'omp-ref',
      prompt: 'cold prompt',
    }),
    ['omp', '--session-dir', '/tmp/s1', '--resume', 'omp-ref', 'cold prompt'],
  );
  assert.deepEqual(
    plugin.launchArgv({
      sessionId: 'session-1',
      cwd: '/workspace',
      storageDir: '/tmp/s1',
      model: 'opus',
    }),
    ['omp', '--model=opus', '--session-dir', '/tmp/s1'],
  );
});

test('JSONL tailer waits for complete lines and labels steering input', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-tailer-'));
  const transcriptPath = path.join(root, 'session.jsonl');
  writeFileSync(transcriptPath, '');
  const context = new TestContext();
  const tailer = new SessionTranscriptTailer({
    transcriptPath,
    sessionId: 'tail-session',
    streamId: 'session:tail-session',
    plugin,
    append: context.append.bind(context),
  });
  try {
    await tailer.start();
    appendFileSync(transcriptPath, '{"type":"message","message":{"role":"user"');
    await tailer.readAvailable();
    assert.equal(context.events.length, 0);
    appendFileSync(
      transcriptPath,
      ',"content":[{"type":"text","text":"hello"}]}}\nnot-json\n{"type":"message","message":{"role":"user","steering":true,"content":[{"type":"text","text":"steer"}]}}\n',
    );
    await tailer.readAvailable();
    assert.deepEqual(
      context.events.map((event) => event.type),
      ['session_input', 'session_input'],
    );
    assert.deepEqual(context.events[0]?.payload, {
      session_id: 'tail-session',
      turn: 1,
      text: 'hello',
    });
    assert.deepEqual(context.events[1]?.payload, {
      session_id: 'tail-session',
      turn: 1,
      text: 'steer',
      steering: true,
    });
  } finally {
    await tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
test('JSONL tailer discovers a transcript created after watching starts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-tailer-new-'));
  const transcriptPath = path.join(root, 'session.jsonl');
  const context = new TestContext();
  const tailer = new SessionTranscriptTailer({
    transcriptPath,
    sessionId: 'tail-session-new',
    streamId: 'session:tail-session-new',
    plugin,
    append: context.append.bind(context),
  });
  try {
    await tailer.start();
    const fixture = readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'test/fixtures/omp-transcript.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .slice(0, 2)
      .join('\n');
    writeFileSync(path.join(root, '2026-08-30T00-00-00-000Z_session.jsonl'), `${fixture}\n`);
    await tailer.readAvailable();
    assert.deepEqual(
      context.events.map((event) => event.type),
      ['session_input', 'session_output', 'turn_complete'],
    );
    assert.equal(tailer.isIdle, true);
  } finally {
    await tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistent session commands use resume argv and raw key passthrough', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-session-'));
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const table = new SessionTable({ filename: ':memory:' });
  let nextId = 0;
  const subsystem = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    idFactory: () => `session-${++nextId}`,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    const opened = await subsystem.open({ provider: 'omp', prompt: 'first prompt', model: 'opus' });
    assert.deepEqual(substrate.created[0]?.argv, [
      'omp',
      '--model=opus',
      '--session-dir',
      path.join(root, 'session-1'),
      'first prompt',
    ]);
    const beforeKeys = substrate.sentKeys.length;
    const sendKeys = context.commands.get('session.send_keys');
    assert.ok(sendKeys);
    assert.deepEqual(
      await sendKeys({ session_id: opened.session_id, keys: ['escape', 'interrupt'] }),
      {
        sent: 2,
      },
    );
    assert.deepEqual(
      substrate.sentKeys.slice(beforeKeys).map((entry) => entry.key),
      ['escape', 'interrupt'],
    );

    const ensureLive = context.commands.get('session.ensure_live');
    assert.ok(ensureLive);
    assert.deepEqual(await ensureLive({ session_id: opened.session_id }), {
      state: 'live',
      substrate_name: 'substrate-session-1',
    });
    assert.equal(substrate.created.length, 1);
    const attachInfo = context.commands.get('session.attach_info');
    assert.ok(attachInfo);
    assert.deepEqual(await attachInfo({ session_id: opened.session_id }), {
      substrate_name: 'substrate-session-1',
      abduco_bin_path: abducoBinaryPath(),
      state: 'live',
    });
    await assert.rejects(
      async () => attachInfo({ session_id: 'missing-session' }),
      /session not found/,
    );

    await subsystem.stop({ session_id: opened.session_id });
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session-exit transcript records mark live sessions resumable and clean substrate', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-session-exit-'));
  const table = new SessionTable({ filename: ':memory:' });
  const substrate = new TestSubstrate();
  const states: Array<{ state: string; reason: string }> = [];
  const transcriptPath = path.join(root, 'exit-session', 'session.jsonl');
  table.upsert({
    sessionId: 'exit-session',
    provider: 'omp',
    harnessRef: 'exit-ref',
    substrateName: 'substrate-exit-session',
    transcriptPath,
    storageDir: path.dirname(transcriptPath),
    state: 'resumable',
    label: '',
    origin: 'agent',
    updatedAt: new Date(0).toISOString(),
  });
  const manager = new PersistentSessionManager({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    sessionStorageDirs: new Map(),
    append: () => 0,
    summaryFor: () => undefined,
    onStateChange: (sessionId, state, reason) => {
      if (sessionId === 'exit-session') states.push({ state, reason });
    },
    reaperIntervalMs: 60_000,
  });
  try {
    await manager.ensureLive('exit-session');
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'custom',
        customType: 'session_exit',
        data: { reason: 'dispose', kind: 'normal' },
      })}\n`,
    );
    await manager.flush();
    await nextImmediate();
    assert.equal(table.get('exit-session')?.state, 'resumable');
    assert.deepEqual(states.at(-1), { state: 'resumable', reason: 'harness-exit' });
    assert.deepEqual(substrate.killedNames, ['substrate-exit-session']);
  } finally {
    await manager.shutdown();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensure-live relaunches a record incorrectly left live after its child exits', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-dead-live-'));
  const table = new SessionTable({ filename: ':memory:' });
  const substrate = new TestSubstrate();
  const states: string[] = [];
  table.upsert({
    sessionId: 'dead-live',
    provider: 'omp',
    harnessRef: 'dead-ref',
    substrateName: 'substrate-dead-live',
    transcriptPath: path.join(root, 'dead-live', 'session.jsonl'),
    storageDir: path.join(root, 'dead-live'),
    state: 'live',
    label: '',
    origin: 'agent',
    updatedAt: new Date(0).toISOString(),
  });
  const manager = new PersistentSessionManager({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    sessionStorageDirs: new Map(),
    append: () => 0,
    summaryFor: () => undefined,
    onStateChange: (sessionId, state) => {
      if (sessionId === 'dead-live') states.push(state);
    },
    reaperIntervalMs: 60_000,
  });
  try {
    assert.deepEqual(await manager.ensureLive('dead-live'), {
      state: 'live',
      substrateName: 'substrate-dead-live',
    });
    assert.equal(substrate.created.length, 1);
    assert.deepEqual(substrate.killedNames, ['substrate-dead-live']);
    assert.deepEqual(states, ['resumable', 'live']);
  } finally {
    await manager.shutdown();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('idle reaper kills persistent substrate and emits reaped state', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-reaper-'));
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const table = new SessionTable({ filename: ':memory:' });
  let clock = 1_000;
  const subsystem = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    idFactory: () => 'idle-session',
    now: () => new Date(clock),
    idleTimeoutMs: 10_000,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    const opened = await subsystem.open({ provider: 'omp', prompt: 'first' });
    assert.equal(opened.session_id, 'idle-session');
    assert.deepEqual(
      table.list().map((record) => record.sessionId),
      ['idle-session'],
    );
    const transcriptPath = table.get('idle-session')?.transcriptPath;
    assert.ok(transcriptPath);
    appendFileSync(
      transcriptPath,
      '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"first"}]}}\n' +
        '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}\n',
    );
    await nextImmediate();
    await subsystem.reapIdle();
    clock += 10_000;
    const reaped = await subsystem.reapIdle();
    assert.deepEqual(reaped, ['idle-session']);
    assert.deepEqual(substrate.killedNames, ['substrate-idle-session']);
    assert.equal(table.get('idle-session')?.state, 'resumable');
    assert.deepEqual(context.events.at(-1)?.payload, {
      session_id: 'idle-session',
      state: 'resumable',
      reason: 'reaped',
    });
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
