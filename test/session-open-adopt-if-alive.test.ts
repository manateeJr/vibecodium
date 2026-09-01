import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { SessionSubsystem } from '../src/session/index.js';
import { SessionTable } from '../src/session/session-table.js';

class TestContext implements SubsystemContext {
  public readonly events: EventEnvelope[] = [];
  private readonly projectors = new Map<string, EventHandler>();
  private nextSequence = 1;

  public registerProjector(name: string, onEvent: EventHandler, from_seq = 0): void {
    this.projectors.set(name, onEvent);
    for (const event of this.events) if (event.seq > from_seq) onEvent(event);
  }

  public registerCommand(): void {}

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
      ts: new Date().toISOString(),
    };
    this.events.push(event);
    for (const projector of this.projectors.values()) projector(event);
    return event.seq;
  }
}

class TestSubstrate implements SubstrateClient {
  public readonly liveNames = new Set<string>();
  public readonly attachedNames: string[] = [];
  public createError: Error | undefined;

  public async createSession(
    name: string,
    argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo> {
    void argv;
    void options;
    if (this.createError) throw this.createError;
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
    this.liveNames.delete(name);
  }

  public async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    return [...this.liveNames].map((name) => ({ name, live: true }));
  }
}

function timeoutError(name: string): Error {
  return new Error(`abduco session did not become live within 5000ms: ${name}`);
}

function createSubsystem(
  root: string,
  context: TestContext,
  table: SessionTable,
  substrate: TestSubstrate,
  sessionId: string,
): SessionSubsystem {
  const subsystem = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    idFactory: () => sessionId,
    reaperIntervalMs: 60_000,
  });
  subsystem.register(context);
  return subsystem;
}

test('a live session is adopted after create liveness timeout and attached', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-adopt-live-'));
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const sessionId = 'adopt-live';
  const substrateName = `substrate-${sessionId}`;
  const subsystem = createSubsystem(root, context, table, substrate, sessionId);
  try {
    await subsystem.reconcile();
    substrate.createError = timeoutError(substrateName);
    substrate.liveNames.add(substrateName);

    const opened = await subsystem.open({ provider: 'omp', prompt: 'start slowly' });

    assert.equal(opened.session_id, sessionId);
    assert.equal(table.get(sessionId)?.state, 'live');
    assert.equal(
      subsystem.list({}).sessions.find((summary) => summary.session_id === sessionId)?.status,
      'live',
    );
    assert.deepEqual(substrate.attachedNames, [substrateName]);
    assert.equal(context.events.filter((event) => event.type === 'verify_failed').length, 0);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dead session still records the original create failure', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-adopt-dead-'));
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const sessionId = 'adopt-dead';
  const substrateName = `substrate-${sessionId}`;
  const subsystem = createSubsystem(root, context, table, substrate, sessionId);
  try {
    await subsystem.reconcile();
    const failure = timeoutError(substrateName);
    substrate.createError = failure;

    await assert.rejects(
      () => subsystem.open({ provider: 'omp', prompt: 'really dead' }),
      /abduco session did not become live within 5000ms/,
    );

    const failures = context.events.filter((event) => event.type === 'verify_failed');
    assert.equal(failures.length, 1);
    assert.equal(table.get(sessionId), undefined);
    assert.deepEqual(substrate.attachedNames, []);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
