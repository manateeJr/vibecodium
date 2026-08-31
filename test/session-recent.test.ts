import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import {
  RECENT_PREVIEW_LINES,
  RECENT_PREVIEW_WIDTH,
  type SessionRecentResult,
} from '../src/contracts/session-recent.js';
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

function started(
  context: TestContext,
  session_id: string,
  origin: 'operator' | 'agent',
  extra: Readonly<Record<string, string>> = {},
): void {
  context.append(`session:${session_id}`, 'session_started', {
    session_id,
    provider: 'omp',
    prompt: `open ${session_id}`,
    origin,
    ...extra,
  });
}

function recent(context: TestContext, args?: unknown): SessionRecentResult {
  const handler = context.commands.get(COMMAND_NAMES.sessionRecent);
  assert.ok(handler, 'session.recent must be registered');
  return handler(args) as SessionRecentResult;
}

test('session.recent returns operator sessions newest first and honours limit', () => {
  const context = new TestContext();
  const subsystem = new SessionSubsystem();
  subsystem.register(context);
  started(context, 'oldest', 'operator', { cwd: '/one' });
  started(context, 'middle', 'operator', { cwd: '/two' });
  started(context, 'newest', 'operator', { cwd: '/three' });
  // An agent-opened session is real work, but it is not the operator's home screen.
  started(context, 'agent-owned', 'agent');

  const all = recent(context);
  assert.deepEqual(
    all.sessions.map((session) => session.session_id),
    ['newest', 'middle', 'oldest'],
  );
  assert.deepEqual(
    recent(context, { limit: 2 }).sessions.map((session) => session.session_id),
    ['newest', 'middle'],
  );
  assert.deepEqual(recent(context, { limit: 0 }).sessions, []);
  assert.equal(all.sessions[0]?.cwd, '/three');
  assert.equal(all.sessions[0]?.origin, 'operator');
  assert.equal(all.sessions[0]?.state, 'live');
  assert.equal(all.sessions[0]?.provider, 'omp');
  assert.throws(() => recent(context, { limit: -1 }), /non-negative integer/);
});

test('session.recent previews keep the last text lines, trimmed for a phone row', () => {
  const context = new TestContext();
  const subsystem = new SessionSubsystem();
  subsystem.register(context);
  started(context, 'chatty', 'operator');
  context.append('session:chatty', 'session_input', {
    session_id: 'chatty',
    turn: 1,
    text: 'first line\n\n  second line  ',
  });
  const long = 'x'.repeat(RECENT_PREVIEW_WIDTH + 40);
  context.append('session:chatty', 'session_output', {
    session_id: 'chatty',
    index: 1,
    text: `third line\n${long}`,
  });

  const preview = recent(context).sessions[0]?.preview ?? [];
  assert.equal(preview.length, RECENT_PREVIEW_LINES);
  assert.deepEqual(preview.slice(0, 2), ['second line', 'third line']);
  assert.equal(preview[2]?.length, RECENT_PREVIEW_WIDTH);
  assert.equal(preview[2]?.endsWith('…'), true);
});

test('session.recent previews treat a missing kind as text and skip thinking and tool output', () => {
  const context = new TestContext();
  const subsystem = new SessionSubsystem();
  subsystem.register(context);
  started(context, 'reasoning', 'operator');
  // No `kind` at all: every event persisted before the field existed reads as text.
  context.appendRaw('session:reasoning', 'session_output', {
    session_id: 'reasoning',
    index: 1,
    text: 'plain answer',
  });
  context.appendRaw('session:reasoning', 'session_output', {
    session_id: 'reasoning',
    index: 2,
    text: 'weighing the options',
    kind: 'thinking',
  });
  context.appendRaw('session:reasoning', 'session_output', {
    session_id: 'reasoning',
    index: 3,
    text: 'read file.ts',
    kind: 'tool',
    tool: { name: 'read', summary: 'file.ts', status: 'ok' },
  });
  context.appendRaw('session:reasoning', 'session_output', {
    session_id: 'reasoning',
    index: 4,
    text: 'explicit text kind',
    kind: 'text',
  });

  assert.deepEqual(recent(context).sessions[0]?.preview, ['plain answer', 'explicit text kind']);
});
