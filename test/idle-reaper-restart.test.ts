import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  SubstrateSessionRecord,
  SubstrateSessionState,
} from '../src/contracts/substrate-contract.js';
import { SessionSubsystem } from '../src/session/index.js';
import { SessionTable } from '../src/session/session-table.js';

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
      seq: this.nextSequence,
      type,
      payload,
      ts: new Date(this.nextSequence * 1000).toISOString(),
    };
    this.nextSequence += 1;
    this.events.push(event);
    for (const projector of this.projectors.values()) projector(event);
    return event.seq;
  }
}

class TestSubstrate implements SubstrateClient {
  public readonly attachedNames: string[] = [];
  public readonly killedNames: string[] = [];
  private readonly liveNames: Set<string>;

  public constructor(liveNames: readonly string[]) {
    this.liveNames = new Set(liveNames);
  }

  public async createSession(
    name: string,
    argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo> {
    void argv;
    void options;
    this.liveNames.add(name);
    return { name, live: true };
  }

  public async attach(name: string): Promise<SubstrateAttachment> {
    this.attachedNames.push(name);
    return { name, detach: async () => undefined };
  }

  public async write(name: string, bytes: Uint8Array): Promise<void> {
    void name;
    void bytes;
  }

  public async sendKey(name: string, key: SubstrateKey): Promise<void> {
    void name;
    void key;
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
class BlockingListSubstrate extends TestSubstrate {
  private blocked = false;
  private releaseBlockedList!: () => void;
  private resolveListStarted!: () => void;
  private listGate!: Promise<void>;
  public listStarted!: Promise<void>;

  public blockNextList(): void {
    this.blocked = true;
    this.listStarted = new Promise((resolve) => {
      this.resolveListStarted = resolve;
    });
    this.listGate = new Promise((resolve) => {
      this.releaseBlockedList = resolve;
    });
  }

  public releaseList(): void {
    this.releaseBlockedList();
  }

  public override async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    if (this.blocked) {
      this.blocked = false;
      this.resolveListStarted();
      await this.listGate;
    }
    return super.listSessions();
  }
}

function sessionRecord(
  root: string,
  sessionId: string,
  state: SubstrateSessionState,
): SubstrateSessionRecord {
  const storageDir = path.join(root, sessionId);
  return {
    sessionId,
    provider: 'omp',
    harnessRef: `harness-${sessionId}`,
    substrateName: `substrate-${sessionId}`,
    transcriptPath: path.join(storageDir, 'session.jsonl'),
    storageDir,
    state,
    label: '',
    origin: 'agent',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

function writeTranscript(
  transcriptPath: string,
  records: readonly Record<string, unknown>[],
): void {
  mkdirSync(path.dirname(transcriptPath), { recursive: true });
  appendFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}
function createSubsystem(
  options: ConstructorParameters<typeof SessionSubsystem>[0],
): SessionSubsystem {
  const previous = process.env.VIBECODIUM_MEMORY_PRESSURE_MIN_MB;
  process.env.VIBECODIUM_MEMORY_PRESSURE_MIN_MB = '0';
  try {
    return new SessionSubsystem(options);
  } finally {
    if (previous === undefined) delete process.env.VIBECODIUM_MEMORY_PRESSURE_MIN_MB;
    else process.env.VIBECODIUM_MEMORY_PRESSURE_MIN_MB = previous;
  }
}

function assistantStop(timestamp: string): Record<string, unknown> {
  return {
    type: 'message',
    timestamp,
    message: { role: 'assistant', content: 'done' },
    stopReason: 'stop',
  };
}

function userRecord(timestamp: string): Record<string, unknown> {
  return {
    type: 'message',
    timestamp,
    message: { role: 'user', content: 'unfinished' },
  };
}

test('reconcile seeds an old idle tail and reaps it on the first sweep', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-restart-idle-'));
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const sessionId = 'restart-idle';
  const nowMs = Date.parse('2026-09-02T12:00:00.000Z');
  const record = sessionRecord(root, sessionId, 'live');
  writeTranscript(record.transcriptPath, [assistantStop(new Date(nowMs - 120_000).toISOString())]);
  table.upsert(record);
  context.append(`session:${sessionId}`, 'session_started', {
    session_id: sessionId,
    provider: 'omp',
    prompt: 'old prompt',
  });
  const substrate = new TestSubstrate([record.substrateName]);
  const subsystem = createSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    now: () => new Date(nowMs),
    idleTimeoutMs: 60_000,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    await subsystem.reconcile();
    assert.equal(
      context.events.some(
        (event) => event.type === 'session_input' || event.type === 'session_output',
      ),
      false,
    );
    assert.deepEqual(await subsystem.reapIdle(), [sessionId]);
    assert.deepEqual(substrate.killedNames, [record.substrateName]);
    assert.equal(table.get(sessionId)?.state, 'resumable');
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconcile does not reap a transcript ending with an unfinished user turn', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-restart-active-'));
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const sessionId = 'restart-active';
  const nowMs = Date.parse('2026-09-02T12:00:00.000Z');
  const record = sessionRecord(root, sessionId, 'live');
  const oldTimestamp = new Date(nowMs - 120_000).toISOString();
  writeTranscript(record.transcriptPath, [assistantStop(oldTimestamp), userRecord(oldTimestamp)]);
  table.upsert(record);
  context.append(`session:${sessionId}`, 'session_started', {
    session_id: sessionId,
    provider: 'omp',
    prompt: 'old prompt',
  });
  const substrate = new TestSubstrate([record.substrateName]);
  const subsystem = createSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    now: () => new Date(nowMs),
    idleTimeoutMs: 60_000,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    await subsystem.reconcile();
    assert.deepEqual(await subsystem.reapIdle(), []);
    assert.deepEqual(substrate.killedNames, []);
    assert.equal(table.get(sessionId)?.state, 'live');
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session.stop closes a resumable durable row without a live worker', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-stop-reaped-'));
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const sessionId = 'reaped-row';
  const record = sessionRecord(root, sessionId, 'resumable');
  table.upsert(record);
  context.append(`session:${sessionId}`, 'session_started', {
    session_id: sessionId,
    provider: 'omp',
    prompt: 'old prompt',
  });
  const subsystem = createSubsystem({
    substrate: new TestSubstrate([]),
    sessionTable: table,
    sessionStorageRoot: root,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    await subsystem.reconcile();
    assert.deepEqual(await subsystem.stop({ session_id: sessionId }), { stopped: true });
    assert.equal(table.get(sessionId)?.state, 'closed');
    assert.deepEqual(context.events.at(-1)?.payload, {
      session_id: sessionId,
      provider: 'omp',
    });
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('closed resumable rows ignore stale transitions and repeated stops', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-stop-idempotent-'));
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const sessionId = 'closed-row';
  const record = sessionRecord(root, sessionId, 'resumable');
  table.upsert(record);
  context.append(`session:${sessionId}`, 'session_started', {
    session_id: sessionId,
    provider: 'omp',
    prompt: 'old prompt',
  });
  const subsystem = createSubsystem({
    substrate: new TestSubstrate([]),
    sessionTable: table,
    sessionStorageRoot: root,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    await subsystem.reconcile();
    assert.deepEqual(await subsystem.stop({ session_id: sessionId }), { stopped: true });
    const eventCount = context.events.length;
    subsystem.emitSessionState(sessionId, 'resumable', 'shutdown');
    assert.equal(table.get(sessionId)?.state, 'closed');
    assert.equal(context.events.length, eventCount);
    assert.deepEqual(await subsystem.stop({ session_id: sessionId }), { stopped: false });
    assert.equal(context.events.filter((event) => event.type === 'session_complete').length, 1);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('a liveness sweep cannot resurrect a row closed while the sweep is pending', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-stop-race-'));
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const sessionId = 'stop-race';
  const substrate = new BlockingListSubstrate([]);
  const subsystem = createSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    idFactory: () => sessionId,
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    await subsystem.reconcile();
    await subsystem.open({ provider: 'omp', prompt: 'active prompt' });
    substrate.blockNextList();
    const sweep = subsystem.reapIdle();
    await substrate.listStarted;
    assert.deepEqual(await subsystem.stop({ session_id: sessionId }), { stopped: true });
    substrate.releaseList();
    await sweep;
    assert.equal(table.get(sessionId)?.state, 'closed');
    assert.equal(context.events.filter((event) => event.type === 'session_complete').length, 1);
    assert.deepEqual(await subsystem.stop({ session_id: sessionId }), { stopped: false });
    assert.equal(context.events.filter((event) => event.type === 'session_complete').length, 1);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
