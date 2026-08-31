import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { SubsystemContext } from '../src/contracts/subsystem.js';
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

class TestSubstrate implements SubstrateClient {
  public readonly writes: Array<{ name: string; text: string }> = [];
  public readonly liveNames = new Set<string>();

  public async createSession(
    name: string,
    _argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo> {
    void options;
    this.liveNames.add(name);
    return { name, live: true };
  }

  public async attach(name: string): Promise<SubstrateAttachment> {
    return { name, detach: async () => undefined };
  }

  public async write(name: string, bytes: Uint8Array): Promise<void> {
    this.writes.push({ name, text: new TextDecoder().decode(bytes) });
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

function completeTurn(worker: FakeWorker, streamId: string, sessionId: string, turn: number): void {
  worker.emit('message', {
    type: 'event',
    stream_id: streamId,
    event_type: 'turn_complete',
    payload: { session_id: sessionId, turn },
  });
}

function turnMessages(worker: FakeWorker): readonly Record<string, unknown>[] {
  return worker.messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'turn',
  );
}

test('session.send deduplicates keyed in-process turns', async () => {
  const context = new TestContext();
  const worker = new FakeWorker();
  const subsystem = new SessionSubsystem({
    idFactory: () => 'in-process-idempotency',
    fork: () => worker as unknown as ChildProcess,
  });
  subsystem.register(context);
  const opened = await subsystem.open({ provider: 'fake', prompt: 'initial' });
  completeTurn(worker, opened.stream_id, opened.session_id, 1);

  const first = subsystem.send({
    session_id: opened.session_id,
    prompt: 'same prompt',
    idempotency_key: 'same-key',
  });
  const duplicate = subsystem.send({
    session_id: opened.session_id,
    prompt: 'same prompt',
    idempotency_key: 'same-key',
  });
  assert.deepEqual(await duplicate, await first);
  assert.deepEqual(await first, { stream_id: opened.stream_id, turn: 2 });
  assert.deepEqual(turnMessages(worker), [
    { type: 'turn', stream_id: opened.stream_id, prompt: 'same prompt' },
  ]);

  completeTurn(worker, opened.stream_id, opened.session_id, 2);
  subsystem.send({
    session_id: opened.session_id,
    prompt: 'different prompt',
    idempotency_key: 'different-key',
  });
  assert.equal(turnMessages(worker).length, 2);

  completeTurn(worker, opened.stream_id, opened.session_id, 3);
  subsystem.send({ session_id: opened.session_id, prompt: 'without key' });
  assert.equal(turnMessages(worker).length, 3);
  assert.throws(
    () => subsystem.send({ session_id: opened.session_id, prompt: 'without key' }),
    /session is busy/,
  );
  subsystem.stopAll();
});

test('session.send deduplicates keyed persistent turns and leaves unkeyed sends unchanged', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-idempotency-'));
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const table = new SessionTable({ filename: ':memory:' });
  const subsystem = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: root,
    idFactory: () => 'persistent-idempotency',
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    const opened = await subsystem.open({ provider: 'omp', prompt: 'initial' });
    const first = subsystem.send({
      session_id: opened.session_id,
      prompt: 'same prompt',
      idempotency_key: 'same-key',
    });
    const duplicate = subsystem.send({
      session_id: opened.session_id,
      prompt: 'same prompt',
      idempotency_key: 'same-key',
    });
    assert.deepEqual(await duplicate, await first);
    assert.deepEqual(await first, {
      stream_id: `session:${opened.session_id}`,
      turn: 0,
    });

    subsystem.send({
      session_id: opened.session_id,
      prompt: 'different prompt',
      idempotency_key: 'different-key',
    });
    subsystem.send({ session_id: opened.session_id, prompt: 'without key' });
    subsystem.send({ session_id: opened.session_id, prompt: 'without key' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      substrate.writes.map((write) => write.text),
      ['same prompt', 'different prompt', 'without key', 'without key'],
    );
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
