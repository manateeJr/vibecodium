import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { SessionSummary } from '../src/contracts/session-commands.js';
import {
  SOAK_FAKE_DURATION_MS,
  assertEventInvariants,
  assertNoStuckSessions,
  assertReplayMatchesLive,
  parseSoakArgs,
  soakDurationMs,
} from '../src/soak/helpers.js';

const sessionId = 'soak-session';
const streamId = `session:${sessionId}`;
let sequence = 0;

function event<K extends EventKind>(type: K, payload: EventPayload<K>): EventEnvelope<K> {
  sequence += 1;
  return {
    seq: sequence,
    stream_id: streamId,
    type,
    payload,
    ts: new Date(sequence * 1_000).toISOString(),
  };
}

test('soak arguments default to real OMP and cap fake runs at two minutes', () => {
  assert.deepEqual(parseSoakArgs([]), { provider: 'omp', minutes: 30 });
  assert.deepEqual(parseSoakArgs(['--provider', 'fake', '--minutes', '4']), {
    provider: 'fake',
    minutes: 4,
  });
  assert.equal(soakDurationMs({ provider: 'fake', minutes: 30 }), SOAK_FAKE_DURATION_MS);
  assert.equal(soakDurationMs({ provider: 'omp', minutes: 8 }), 8 * 60 * 1_000);
  assert.throws(() => parseSoakArgs(['--minutes', '0']), /positive/);
  assert.throws(() => parseSoakArgs(['--provider', 'bogus']), /fake or omp/);
});

test('event invariants pair turns, allow steering, and preserve duplicate turn numbers on resume', () => {
  sequence = 0;
  const events: EventEnvelope[] = [
    event('session_started', {
      session_id: sessionId,
      provider: 'fake',
      prompt: 'initial prompt',
      origin: 'operator',
    }),
    event('turn_complete', { session_id: sessionId, turn: 1 }),
    event('session_input', { session_id: sessionId, turn: 2, text: 'second' }),
    event('session_input', { session_id: sessionId, turn: 2, text: 'steer', steering: true }),
    event('session_output', { session_id: sessionId, index: 0, text: 'reply' }),
    event('turn_complete', { session_id: sessionId, turn: 2 }),
    event('turn_complete', { session_id: sessionId, turn: 2 }),
    event('session_input', { session_id: sessionId, turn: 1, text: 'cold resume' }),
    event('turn_complete', { session_id: sessionId, turn: 1 }),
    event('session_complete', { session_id: sessionId, provider: 'fake' }),
  ];
  const report = assertEventInvariants(events, streamId);
  assert.equal(report.eventCount, 10);
  assert.equal(report.turnCount, 3);
  assert.equal(report.replayCount, 10);
  assert.equal(report.kinds.session_input, 3);
  assert.equal(report.kinds.turn_complete, 4);
});

test('event replay and stuck-session checks reject drift', () => {
  sequence = 0;
  const events = [
    event('session_started', { session_id: sessionId, provider: 'fake', prompt: 'prompt' }),
    event('turn_complete', { session_id: sessionId, turn: 1 }),
  ];
  assertReplayMatchesLive(events, [...events]);
  assert.throws(() => assertReplayMatchesLive(events, events.slice(0, 1)), /replay count mismatch/);
  const done: SessionSummary = {
    session_id: sessionId,
    stream_id: streamId,
    provider: 'fake',
    label: '',
    origin: 'operator',
    status: 'done',
  };
  assertNoStuckSessions([done]);
  assert.throws(() => assertNoStuckSessions([{ ...done, status: 'live' }]), /stuck live/);
});
