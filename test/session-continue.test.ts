import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type {
  MachineSessionResolver,
  ResolvedMachineSession,
} from '../src/machine-sessions/index.js';
import { SessionSubsystem } from '../src/session/index.js';
import { SessionTable } from '../src/session/session-table.js';
import type { CommandHandler, EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateCreateOptions,
  SubstrateSessionInfo,
} from '../src/contracts/substrate-contract.js';

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
  public readonly created: Array<{
    name: string;
    argv: readonly string[];
    options?: SubstrateCreateOptions;
  }> = [];
  public onCreate: (() => void) | undefined;
  public readonly live = new Set<string>();

  public async createSession(
    name: string,
    argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo> {
    this.created.push({ name, argv, ...(options === undefined ? {} : { options }) });
    this.onCreate?.();
    this.live.add(name);
    return { name, live: true };
  }

  public async attach(name: string): Promise<SubstrateAttachment> {
    return { name, detach: async () => undefined };
  }

  public async write(): Promise<void> {}

  public async sendKey(): Promise<void> {}

  public onOutput(): () => void {
    return () => undefined;
  }

  public async isLive(name: string): Promise<boolean> {
    return this.live.has(name);
  }

  public async kill(name: string): Promise<void> {
    this.live.delete(name);
  }

  public async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    return [...this.live].map((name) => ({ name, live: true }));
  }
}

function writeTranscript(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'title', title: 'External conversation' })}\n` +
      `${JSON.stringify({ type: 'session', cwd: '/workspace/external' })}\n` +
      `${JSON.stringify({ role: 'user', content: 'remember this context' })}\n`,
  );
}

function resolvedExternal(ref: string, file: string): ResolvedMachineSession {
  return {
    source: 'omp',
    ref,
    title: 'External conversation',
    cwd: '/workspace/external',
    updated_at: new Date(0).toISOString(),
    kind: 'main',
    path: file,
  };
}

function resolverFor(session: ResolvedMachineSession): MachineSessionResolver {
  return {
    resolve: async (ref) => (ref === session.ref ? session : undefined),
  };
}

function ageFile(file: string, ageMs: number): void {
  const timestamp = (Date.now() - ageMs) / 1000;
  utimesSync(file, timestamp, timestamp);
}

function makeSubsystem(
  root: string,
  session: ResolvedMachineSession,
  substrate: TestSubstrate,
  table: SessionTable,
  idFactory = () => 'continued-session',
): SessionSubsystem {
  return new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: path.join(root, 'vibecodium'),
    machineSessions: resolverFor(session),
    idFactory,
    reaperIntervalMs: 60_000,
  });
}

test('session.resume continues an external ref with durable lineage and hydrated metadata', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-session-continue-'));
  const source = path.join(root, 'machine', 'external.jsonl');
  const ref = 'external-omp-ref';
  writeTranscript(source);
  ageFile(source, 120_000);
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const substrate = new TestSubstrate();
  substrate.onCreate = () => {
    writeFileSync(
      source,
      `${JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly CONT_OK' }] },
      })}\n` +
        `${JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'CONT_OK' }],
            stopReason: 'stop',
          },
        })}\n`,
      { flag: 'a' },
    );
  };
  const subsystem = makeSubsystem(root, resolvedExternal(ref, source), substrate, table);

  try {
    subsystem.register(context);
    const result = await context.commands.get(COMMAND_NAMES.sessionResume)?.({
      source: 'omp',
      ref,
      prompt: 'Reply with exactly CONT_OK',
    });

    assert.deepEqual(result, {
      session_id: 'continued-session',
      stream_id: 'session:continued-session',
    });
    assert.deepEqual(substrate.created[0], {
      name: 'substrate-continued-session',
      argv: [
        'omp',
        '--session-dir',
        path.dirname(source),
        '--resume',
        ref,
        'Reply with exactly CONT_OK',
      ],
      options: { cwd: '/workspace/external' },
    });
    const persisted = table.get('continued-session');
    assert.ok(persisted);

    assert.equal(persisted.provider, 'omp');
    assert.equal(persisted.harnessRef, ref);
    assert.equal(persisted.storageDir, path.dirname(source));
    assert.equal(persisted.transcriptPath, source);
    assert.equal(persisted.state, 'live');
    assert.equal(persisted.origin, 'agent');
    assert.equal(persisted.label, 'External conversation');

    const summary = subsystem.list({}).sessions[0];
    assert.ok(summary);
    assert.equal(summary.session_id, 'continued-session');
    assert.equal(summary.stream_id, 'session:continued-session');
    assert.equal(summary.provider, 'omp');
    assert.equal(summary.label, 'External conversation');
    assert.equal(summary.origin, 'agent');
    assert.equal(summary.status, 'live');
    assert.equal(summary.prompt, 'Reply with exactly CONT_OK');
    assert.equal(summary.started_at, new Date(1000).toISOString());
    assert.ok(summary.updated_at);
    assert.equal(summary.cwd, '/workspace/external');
    assert.deepEqual(context.events[0]?.payload, {
      session_id: 'continued-session',
      provider: 'omp',
      prompt: 'Reply with exactly CONT_OK',
      cwd: '/workspace/external',
      origin: 'agent',
    });
    const lines = readFileSync(source, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 5);
    assert.deepEqual(lines.slice(3), [
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly CONT_OK' }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'CONT_OK' }],
          stopReason: 'stop',
        },
      },
    ]);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session.resume rejects a freshly written external transcript before spawning', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-session-continue-active-'));
  const source = path.join(root, 'machine', 'external.jsonl');
  const session = resolvedExternal('active-ref', source);
  writeTranscript(source);
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const subsystem = makeSubsystem(root, session, substrate, table);

  try {
    subsystem.register(context);
    const resume = context.commands.get(COMMAND_NAMES.sessionResume);
    assert.ok(resume);
    await assert.rejects(
      async () =>
        resume({
          source: 'omp',
          ref: session.ref,
          prompt: 'do not start',
        }),
      /external session appears active on this machine/,
    );
    assert.equal(substrate.created.length, 0);
    assert.equal(table.list().length, 0);
    assert.equal(context.events.length, 0);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session.resume allows an external transcript older than the default active window', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-session-continue-idle-'));
  const source = path.join(root, 'machine', 'external.jsonl');
  const session = resolvedExternal('idle-ref', source);
  writeTranscript(source);
  ageFile(source, 120_000);
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const subsystem = makeSubsystem(root, session, substrate, table);

  try {
    subsystem.register(context);
    await context.commands.get(COMMAND_NAMES.sessionResume)?.({
      source: 'omp',
      ref: session.ref,
      prompt: 'continue idle session',
    });
    assert.equal(substrate.created.length, 1);
    assert.equal(table.get('continued-session')?.harnessRef, session.ref);
  } finally {
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session.resume honors VIBECODIUM_EXTERNAL_ACTIVE_WINDOW_MS', async () => {
  const previous = process.env.VIBECODIUM_EXTERNAL_ACTIVE_WINDOW_MS;
  process.env.VIBECODIUM_EXTERNAL_ACTIVE_WINDOW_MS = '600000';
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-session-continue-window-'));
  const source = path.join(root, 'machine', 'external.jsonl');
  const session = resolvedExternal('window-ref', source);
  writeTranscript(source);
  ageFile(source, 120_000);
  const table = new SessionTable({ filename: ':memory:' });
  const context = new TestContext();
  const substrate = new TestSubstrate();
  const subsystem = makeSubsystem(root, session, substrate, table);

  try {
    subsystem.register(context);
    const resume = context.commands.get(COMMAND_NAMES.sessionResume);
    assert.ok(resume);
    await assert.rejects(
      async () =>
        resume({
          source: 'omp',
          ref: session.ref,
          prompt: 'window should reject',
        }),
      /appears active/,
    );
    assert.equal(substrate.created.length, 0);
  } finally {
    if (previous === undefined) delete process.env.VIBECODIUM_EXTERNAL_ACTIVE_WINDOW_MS;
    else process.env.VIBECODIUM_EXTERNAL_ACTIVE_WINDOW_MS = previous;
    subsystem.stopAll();
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
