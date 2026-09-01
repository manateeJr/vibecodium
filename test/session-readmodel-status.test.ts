import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { EventKind, EventPayload } from '../src/contracts/events.js';
import type { SessionRecentResult } from '../src/contracts/session-recent.js';
import type { CommandHandler, EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateSessionInfo,
} from '../src/contracts/substrate-contract.js';
import { EventStore } from '../src/server/event-store.js';
import { SessionSubsystem } from '../src/session/index.js';
import { SessionTable } from '../src/session/session-table.js';

class StoreContext implements SubsystemContext {
  public readonly commands = new Map<string, CommandHandler>();
  private readonly unsubscribers: Array<() => void> = [];
  public constructor(public readonly store: EventStore) {}
  public registerProjector(name: string, onEvent: EventHandler, from_seq = 0): void {
    this.store.saveProjectorCursor(name, from_seq);
    this.unsubscribers.push(
      this.store.subscribeAll(from_seq, (event) => {
        onEvent(event);
        this.store.saveProjectorCursor(name, event.seq);
      }),
    );
  }
  public registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }
  public registerListener(): void {}
  public subscribe(from_seq: number, onEvent: EventHandler): () => void {
    return this.store.subscribeAll(from_seq, onEvent);
  }
  public append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number {
    return this.store.append(stream_id, type, payload);
  }
  public close(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }
}

class LiveButUnattachableSubstrate implements SubstrateClient {
  public attachCalls = 0;
  public killCalls = 0;
  public constructor(private readonly liveName: string) {}
  public async createSession(name: string): Promise<SubstrateSessionInfo> {
    return { name, live: true };
  }
  public async attach(): Promise<SubstrateAttachment> {
    this.attachCalls += 1;
    throw new Error('tailer failed to start');
  }
  public async write(): Promise<void> {}
  public async sendKey(): Promise<void> {}
  public onOutput(): () => void {
    return () => undefined;
  }
  public async isLive(name: string): Promise<boolean> {
    return name === this.liveName;
  }
  public async kill(): Promise<void> {
    this.killCalls += 1;
  }
  public async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    return [{ name: this.liveName, live: true }];
  }
}

async function recent(context: StoreContext, command: unknown): Promise<SessionRecentResult> {
  const handler = context.commands.get(COMMAND_NAMES.sessionRecent);
  assert.ok(handler);
  return (await handler(command)) as SessionRecentResult;
}

function closeModel(context: StoreContext, table: SessionTable): void {
  context.close();
  table.close();
  context.store.close();
}

test('summary replay survives restart for event-only sessions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-read-model-'));
  const filename = path.join(directory, 'control-plane.sqlite');
  const firstStore = new EventStore({ filename });
  const firstContext = new StoreContext(firstStore);
  const firstTable = new SessionTable({ filename });
  const firstSubsystem = new SessionSubsystem({ sessionTable: firstTable });
  firstSubsystem.register(firstContext);
  firstStore.append('session:before-restart', 'session_started', {
    session_id: 'before-restart',
    provider: 'fake',
    prompt: 'survive restart',
    origin: 'operator',
  });
  firstStore.append('session:event-only-failed-open', 'session_started', {
    session_id: 'event-only-failed-open',
    provider: 'fake',
    prompt: 'failed open',
    origin: 'operator',
  });
  firstStore.append('session:event-only-failed-open', 'verify_failed', {
    session_id: 'event-only-failed-open',
    stage: 'session',
    error: 'worker never started',
  });
  assert.equal(firstTable.get('event-only-failed-open'), undefined);
  closeModel(firstContext, firstTable);

  const secondStore = new EventStore({ filename });
  const secondContext = new StoreContext(secondStore);
  const secondTable = new SessionTable({ filename });
  const secondSubsystem = new SessionSubsystem({ sessionTable: secondTable });
  secondSubsystem.register(secondContext);
  try {
    const result = await recent(secondContext, { include_ended: true, limit: 10 });
    assert.deepEqual(result.sessions.map((session) => session.session_id).sort(), [
      'before-restart',
      'event-only-failed-open',
    ]);
    assert.equal(
      result.sessions.find((session) => session.session_id === 'event-only-failed-open')?.state,
      'failed',
    );
  } finally {
    closeModel(secondContext, secondTable);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a live daemon stays live after both reconcile attach attempts fail', async () => {
  const store = new EventStore({ filename: ':memory:' });
  const context = new StoreContext(store);
  const table = new SessionTable({ filename: ':memory:' });
  const sessionId = 'live-attach-failure';
  const substrateName = `substrate-${sessionId}`;
  const substrate = new LiveButUnattachableSubstrate(substrateName);
  table.upsert({
    sessionId,
    provider: 'fake',
    harnessRef: 'harness-live',
    substrateName,
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    storageDir: `/tmp/${sessionId}`,
    state: 'live',
    updatedAt: new Date(0).toISOString(),
  });
  store.append(`session:${sessionId}`, 'session_started', {
    session_id: sessionId,
    provider: 'fake',
    prompt: 'still running',
    origin: 'operator',
  });
  const subsystem = new SessionSubsystem({ substrate, sessionTable: table });
  subsystem.register(context);
  try {
    await subsystem.reconcile();
    const result = await recent(context, { include_ended: true, limit: 10 });
    assert.equal(result.sessions[0]?.state, 'live');
    assert.equal(substrate.attachCalls, 2);
    assert.equal(substrate.killCalls, 0);
  } finally {
    subsystem.stopAll();
    context.close();
    table.close();
    store.close();
  }
});

test('session_state exposes resumable distinctly in session.recent', async () => {
  const store = new EventStore({ filename: ':memory:' });
  const context = new StoreContext(store);
  const subsystem = new SessionSubsystem();
  store.append('session:resumable', 'session_started', {
    session_id: 'resumable',
    provider: 'fake',
    prompt: 'resume me',
    origin: 'operator',
  });
  store.append('session:resumable', 'session_state', {
    session_id: 'resumable',
    state: 'resumable',
    reason: 'reconciled',
  });
  subsystem.register(context);
  try {
    const result = await recent(context, { include_ended: true, limit: 10 });
    assert.equal(result.sessions[0]?.state, 'resumable');
  } finally {
    context.close();
    store.close();
  }
});
