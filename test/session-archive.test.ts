import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope } from '../src/contracts/events.js';
import type { SessionSummary } from '../src/contracts/session-commands.js';
import type { SubstrateSessionRecord } from '../src/contracts/substrate-contract.js';
import { recentSessions, SessionPreviews } from '../src/session/recent-sessions.js';
import { archiveSession } from '../src/session/session-archive.js';
import { listSessions } from '../src/session/session-helpers.js';
import {
  projectSessionEvent,
  type SessionSummaryRecord,
} from '../src/session/session-summary-projector.js';
import { SessionTable } from '../src/session/session-table.js';

function summary(session_id: string, started_at: string, archived = false): SessionSummary {
  return {
    session_id,
    stream_id: `session:${session_id}`,
    provider: 'omp',
    label: '',
    origin: 'operator',
    status: 'live',
    started_at,
    updated_at: started_at,
    ...(archived ? { archived: true } : {}),
  };
}

function record(
  session_id: string,
  started_at: string,
  archived = false,
  startedSeq = 1,
): SessionSummaryRecord {
  return { summary: summary(session_id, started_at, archived), startedSeq };
}

function storedRecord(sessionId: string, archived = false): SubstrateSessionRecord {
  return {
    sessionId,
    provider: 'omp',
    harnessRef: `harness-${sessionId}`,
    substrateName: `substrate-${sessionId}`,
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    storageDir: `/tmp/${sessionId}`,
    state: 'live',
    ...(archived ? { archived: true } : {}),
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

test('session archive toggles the durable row and summary without stopping the session', () => {
  const table = new SessionTable({ filename: ':memory:' });
  const session = record('archive-me', '2026-09-01T00:00:00.000Z');
  const records = new Map([[session.summary.session_id, session]]);
  table.upsert(storedRecord(session.summary.session_id));

  try {
    assert.deepEqual(archiveSession(records, table, { session_id: 'archive-me', archived: true }), {
      archived: true,
    });
    assert.equal(table.get('archive-me')?.archived, true);
    assert.equal(table.get('archive-me')?.state, 'live');
    assert.equal(session.summary.archived, true);

    assert.deepEqual(
      archiveSession(records, table, { session_id: 'archive-me', archived: false }),
      { archived: false },
    );
    assert.equal(table.get('archive-me')?.archived, undefined);
    assert.equal(session.summary.archived, undefined);
    assert.throws(
      () => archiveSession(records, table, { session_id: 'unknown', archived: true }),
      /session not found/,
    );
  } finally {
    table.close();
  }
});

test('session.recent scopes archived sessions and includes the archive flag', () => {
  const records = new Map<string, SessionSummaryRecord>([
    ['active', record('active', '2026-09-01T00:00:01.000Z', false, 1)],
    ['archived', record('archived', '2026-09-01T00:00:02.000Z', true, 2)],
  ]);
  const previews = new SessionPreviews();

  const active = recentSessions(records, previews, {});
  assert.deepEqual(
    active.sessions.map((session) => session.session_id),
    ['active'],
  );
  assert.equal(active.sessions[0]?.archived, false);

  const archived = recentSessions(records, previews, { scope: 'archived' });
  assert.deepEqual(
    archived.sessions.map((session) => session.session_id),
    ['archived'],
  );
  assert.equal(archived.sessions[0]?.archived, true);
  assert.throws(() => recentSessions(records, previews, { scope: 'other' }), /scope/);
});

test('session.list scopes archived sessions and includes the archive flag', () => {
  const records = new Map<string, SessionSummaryRecord>([
    ['active', record('active', '2026-09-01T00:00:01.000Z', false, 1)],
    ['archived', record('archived', '2026-09-01T00:00:02.000Z', true, 2)],
  ]);

  const active = listSessions(records, {});
  assert.deepEqual(
    active.sessions.map((session) => session.session_id),
    ['active'],
  );
  assert.equal(active.sessions[0]?.archived, false);

  const archived = listSessions(records, { scope: 'archived' });
  assert.deepEqual(
    archived.sessions.map((session) => session.session_id),
    ['archived'],
  );
  assert.equal(archived.sessions[0]?.archived, true);
  assert.throws(() => listSessions(records, { scope: 'other' }), /scope/);
});

test('session_started projector carries archived state from the durable record', () => {
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert(storedRecord('projected', true));
  const records = new Map<string, SessionSummaryRecord>();
  const event = {
    stream_id: 'session:projected',
    seq: 1,
    type: 'session_started',
    ts: '2026-09-01T00:00:00.000Z',
    payload: {
      session_id: 'projected',
      provider: 'omp',
      prompt: 'project this session',
    },
  } as EventEnvelope;

  try {
    projectSessionEvent(event, {
      records,
      sessionTable: table,
      sessionStartStatus: () => 'live',
      isLive: () => true,
    });
    assert.equal(records.get('projected')?.summary.archived, true);
  } finally {
    table.close();
  }
});
