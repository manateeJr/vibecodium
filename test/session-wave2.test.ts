import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { CommandHandler, EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateSessionInfo,
} from '../src/contracts/substrate-contract.js';
import { createMachineSessionsSubsystem } from '../src/machine-sessions/index.js';
import { SessionSubsystem } from '../src/session/index.js';
import { SessionTable } from '../src/session/session-table.js';

class Context implements SubsystemContext {
  readonly events: EventEnvelope[] = [];
  readonly commands = new Map<string, CommandHandler>();
  private nextSeq = 1;
  private readonly projectors = new Map<string, EventHandler>();

  registerProjector(name: string, handler: EventHandler, from_seq = 0): void {
    this.projectors.set(name, handler);
    for (const event of this.events) if (event.seq > from_seq) handler(event);
  }
  registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }
  registerListener(): void {}
  subscribe(): () => void {
    return () => undefined;
  }
  append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number {
    const event = {
      stream_id,
      seq: this.nextSeq++,
      type,
      payload,
      ts: new Date(this.nextSeq * 1000).toISOString(),
    } as EventEnvelope<K>;
    this.events.push(event);
    for (const handler of this.projectors.values()) handler(event);
    return event.seq;
  }
}

class Substrate implements SubstrateClient {
  readonly created: Array<{ name: string; argv: readonly string[] }> = [];
  readonly live = new Set<string>();
  async createSession(name: string, argv: readonly string[]): Promise<SubstrateSessionInfo> {
    this.created.push({ name, argv });
    this.live.add(name);
    return { name, live: true };
  }
  async attach(name: string): Promise<SubstrateAttachment> {
    return { name, detach: async () => undefined };
  }
  async write(): Promise<void> {}
  async sendKey(): Promise<void> {}
  onOutput(): () => void {
    return () => undefined;
  }
  async isLive(name: string): Promise<boolean> {
    return this.live.has(name);
  }
  async kill(name: string): Promise<void> {
    this.live.delete(name);
  }
  async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    return [...this.live].map((name) => ({ name, live: true }));
  }
}

function ompRecord(ref: string, agent?: string): readonly unknown[] {
  return [
    { type: 'title', title: 'External context' },
    ...(agent === undefined ? [] : [{ type: 'session_init', agent }]),
    { type: 'session', cwd: '/workspace/external' },
    {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'remember this' }] },
    },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I will' }] },
    },
    ref,
  ];
}

function writeJsonl(file: string, rows: readonly unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${rows
      .slice(0, -1)
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`,
  );
}

test('session rename persists in the durable table and list summary, with agent default', () => {
  const table = new SessionTable({ filename: ':memory:' });
  const context = new Context();
  context.append('session:rename-me', 'session_started', {
    session_id: 'rename-me',
    provider: 'omp',
    prompt: 'first prompt',
    origin: 'operator',
  });
  table.upsert({
    sessionId: 'rename-me',
    provider: 'omp',
    harnessRef: 'omp-ref',
    substrateName: 'substrate-rename-me',
    transcriptPath: '/tmp/rename-me/session.jsonl',
    storageDir: '/tmp/rename-me',
    state: 'resumable',
    updatedAt: '2026-08-30T00:00:00.000Z',
    label: '',
    origin: 'operator',
  });
  const subsystem = new SessionSubsystem({ sessionTable: table });
  subsystem.register(context);
  assert.deepEqual(subsystem.list({}).sessions[0], {
    session_id: 'rename-me',
    stream_id: 'session:rename-me',
    provider: 'omp',
    label: '',
    origin: 'operator',
    status: 'stopped',
    prompt: 'first prompt',
    started_at: new Date(2000).toISOString(),
    updated_at: new Date(2000).toISOString(),
  });
  assert.deepEqual(
    context.commands.get(COMMAND_NAMES.sessionRename)?.({
      session_id: 'rename-me',
      label: 'Renamed session',
    }),
    { label: 'Renamed session' },
  );
  assert.equal(table.get('rename-me')?.label, 'Renamed session');
  assert.equal(subsystem.list({}).sessions[0]?.label, 'Renamed session');
  table.close();
});

test('session table migrates old rows with safe metadata defaults', () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE session_records (
    session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, harness_ref TEXT NOT NULL,
    substrate_name TEXT NOT NULL, transcript_path TEXT NOT NULL, storage_dir TEXT NOT NULL,
    state TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database
    .prepare('INSERT INTO session_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'old',
      'omp',
      'ref',
      'substrate-old',
      '/tmp/old.jsonl',
      '/tmp/old',
      'resumable',
      '2026-08-30T00:00:00.000Z',
    );
  const table = new SessionTable({ database });
  assert.deepEqual(table.get('old')?.label, '');
  assert.deepEqual(table.get('old')?.origin, 'agent');
  table.close();
  database.close();
});

test('external omp fork registers resumable copied store and send resumes it', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-wave2-fork-'));
  const ompRoot = path.join(root, 'machine', 'omp');
  const ref = 'external-omp-ref';
  const source = path.join(ompRoot, '-tmp', `2026-08-30T00-00-00-000Z_${ref}`, 'session.jsonl');
  writeJsonl(source, ompRecord(ref, 'task'));
  const targetRoot = path.join(root, 'vibecodium');
  mkdirSync(targetRoot, { recursive: true });
  const table = new SessionTable({ filename: ':memory:' });
  const context = new Context();
  const substrate = new Substrate();
  const machine = createMachineSessionsSubsystem({
    ompRoot,
    codexRoot: path.join(root, 'missing-codex'),
    now: () => new Date(0),
  });
  const subsystem = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: targetRoot,
    machineSessions: machine,
    idFactory: () => 'forked-session',
    reaperIntervalMs: 60_000,
  });
  try {
    subsystem.register(context);
    const result = await subsystem.fork({ session_id: ref });
    assert.equal(result.new_session_id, 'forked-session');
    const copied = path.join(targetRoot, 'forked-session', 'session.jsonl');
    assert.equal(readFileSync(copied, 'utf8'), readFileSync(source, 'utf8'));
    assert.equal(table.get('forked-session')?.state, 'resumable');
    const sent = await subsystem.send({
      session_id: 'forked-session',
      prompt: 'continue from memory',
    });
    assert.deepEqual(sent, { stream_id: 'session:forked-session', turn: 1 });
    assert.deepEqual(substrate.created[0]?.argv, [
      'omp',
      '--session-dir',
      path.join(targetRoot, 'forked-session'),
      '--resume',
      ref,
      'continue from memory',
    ]);
    const eventTypes = context.events.map((event) => event.type);
    const startedIndex = eventTypes.indexOf('session_started');
    const forkedIndex = eventTypes.indexOf('session_forked');
    assert.ok(startedIndex >= 0 && forkedIndex > startedIndex);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('external codex fork is rejected explicitly', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-wave2-codex-'));
  const codexRoot = path.join(root, 'codex');
  const ref = 'codex-ref';
  const source = path.join(
    codexRoot,
    '2026',
    '08',
    '30',
    `rollout-2026-08-30T00-00-00-${ref}.jsonl`,
  );
  writeJsonl(source, [
    { type: 'session_meta', payload: { cwd: '/workspace' } },
    { type: 'session', id: ref },
  ]);
  const machine = createMachineSessionsSubsystem({
    ompRoot: path.join(root, 'missing-omp'),
    codexRoot,
  });
  const subsystem = new SessionSubsystem({ machineSessions: machine, idFactory: () => 'unused' });
  const context = new Context();
  subsystem.register(context);
  try {
    await assert.rejects(() => subsystem.fork({ session_id: ref }), /codex fork not yet supported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
