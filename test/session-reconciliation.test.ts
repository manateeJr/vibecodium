import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
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
import { SessionSubsystem } from '../src/session/index.js';
import { SessionTable } from '../src/session/session-table.js';

class FakeContext implements SubsystemContext {
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

class FakeWorker extends EventEmitter {
  public connected = true;
  public killed = false;

  public send(_message: unknown, callback?: (error?: Error | null) => void): boolean {
    callback?.();
    return true;
  }

  public kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }
}

class FakeSubstrate implements SubstrateClient {
  public readonly liveNames: ReadonlySet<string>;
  public readonly attachedNames: string[] = [];
  public readonly killedNames: string[] = [];

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
  }

  public async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    return [...this.liveNames].map((name) => ({ name, live: true }));
  }
}

function record(sessionId: string, state: 'live' | 'resumable' | 'closed' = 'live') {
  return {
    sessionId,
    provider: 'omp',
    harnessRef: `harness-${sessionId}`,
    substrateName: `substrate-${sessionId}`,
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    storageDir: `/tmp/${sessionId}`,
    state,
    updatedAt: '2026-08-30T00:00:00.000Z',
    label: '',
    origin: 'agent',
  } as const;
}

test('SessionTable persists records and updates state timestamps', () => {
  const table = new SessionTable({ filename: ':memory:' });
  const initial = record('table-session');
  table.upsert(initial);

  assert.deepEqual(table.get(initial.sessionId), initial);
  assert.deepEqual(table.list(), [initial]);
  const updated = table.updateState(initial.sessionId, 'resumable', '2026-08-30T01:00:00.000Z');
  assert.equal(updated.state, 'resumable');
  assert.equal(updated.updatedAt, '2026-08-30T01:00:00.000Z');
  table.close();
});

test('startup reconciliation keeps a live substrate session live and re-attaches it', async () => {
  const context = new FakeContext();
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert(record('live-session'));
  context.append('session:live-session', 'session_started', {
    session_id: 'live-session',
    provider: 'omp',
    prompt: 'continue me',
  });
  const substrate = new FakeSubstrate(['substrate-live-session']);
  const subsystem = new SessionSubsystem({ substrate, sessionTable: table });
  subsystem.register(context);
  await subsystem.reconcile();

  const summary = subsystem.list({}).sessions[0];
  assert.equal(summary?.status, 'live');
  assert.deepEqual(substrate.attachedNames, ['substrate-live-session']);
  assert.equal(table.get('live-session')?.state, 'live');
  assert.deepEqual(context.events.at(-1)?.payload, {
    session_id: 'live-session',
    state: 'live',
    reason: 'reconciled',
  });
  subsystem.stopAll();
  assert.equal(table.get('live-session')?.state, 'resumable');
  assert.deepEqual(substrate.killedNames, []);
  assert.deepEqual(context.events.at(-1)?.payload, {
    session_id: 'live-session',
    state: 'resumable',
    reason: 'shutdown',
  });
  table.close();
});

test('dead substrate sessions become resumable and emit a reconciled state event', async () => {
  const context = new FakeContext();
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert(record('dead-session'));
  context.append('session:dead-session', 'session_started', {
    session_id: 'dead-session',
    provider: 'omp',
    prompt: 'resume me later',
  });
  const subsystem = new SessionSubsystem({
    substrate: new FakeSubstrate([]),
    sessionTable: table,
  });
  subsystem.register(context);
  await subsystem.reconcile();

  assert.equal(table.get('dead-session')?.state, 'resumable');
  assert.notEqual(subsystem.list({}).sessions[0]?.status, 'live');
  assert.deepEqual(context.events.at(-1)?.payload, {
    session_id: 'dead-session',
    state: 'resumable',
    reason: 'reconciled',
  });
  table.close();
});

test('shutdown marks substrate sessions resumable without killing their workers', async () => {
  const context = new FakeContext();
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert(record('shutdown-session'));
  const worker = new FakeWorker();
  const subsystem = new SessionSubsystem({
    sessionTable: table,
    idFactory: () => 'shutdown-session',
    fork: () => worker as unknown as ChildProcess,
  });
  subsystem.register(context);
  await subsystem.open({ provider: 'omp', prompt: 'keep running' });

  subsystem.stopAll();

  assert.equal(worker.killed, false);
  assert.equal(table.get('shutdown-session')?.state, 'resumable');
  assert.deepEqual(context.events.at(-1)?.payload, {
    session_id: 'shutdown-session',
    state: 'resumable',
    reason: 'shutdown',
  });
  table.close();
});

test('a stale session_started event with a dead substrate is never projected as live', async () => {
  const context = new FakeContext();
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert(record('stale-session'));
  context.append('session:stale-session', 'session_started', {
    session_id: 'stale-session',
    provider: 'omp',
    prompt: 'old prompt',
  });
  const subsystem = new SessionSubsystem({
    substrate: new FakeSubstrate([]),
    sessionTable: table,
  });
  subsystem.register(context);
  await subsystem.reconcile();

  assert.notEqual(subsystem.list({}).sessions[0]?.status, 'live');
  assert.equal(table.get('stale-session')?.state, 'resumable');
  table.close();
});

test('reconciliation explicitly skips when no substrate client is injected', async () => {
  const context = new FakeContext();
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert(record('unwired-session'));
  const subsystem = new SessionSubsystem({ sessionTable: table });
  subsystem.register(context);
  await subsystem.reconcile();

  assert.equal(table.get('unwired-session')?.state, 'live');
  assert.equal(context.events.length, 0);
  table.close();
});
