import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  SESSION_ATTACH_HEARTBEAT_COMMAND,
  SESSION_ATTACH_RELEASE_COMMAND,
} from '../src/contracts/session-commands.js';
import {
  ATTACH_LEASE_DEFAULT_TTL_MS,
  ATTACH_LEASE_MAX_TTL_MS,
  SessionAttachLeases,
  effectiveAttachTtl,
  registerAttachLeases,
} from '../src/session/session-attach-leases.js';
import {
  postSessionAttachHeartbeat,
  postSessionAttachRelease,
} from '../src/client/attach-leases.js';
import { createClient } from '../src/client/index.js';
import { sessionAttachHeartbeat, sessionAttachRelease } from '../src/session/session-helpers.js';
import { SessionTable } from '../src/session/session-table.js';

function setup(): { leases: SessionAttachLeases; table: SessionTable } {
  const db = new Database(':memory:');
  const table = new SessionTable({ database: db });
  const leases = new SessionAttachLeases(db);
  return { leases, table };
}

function seedSession(table: SessionTable, sessionId = 'session-1'): void {
  table.upsert({
    sessionId,
    provider: 'fake',
    harnessRef: sessionId,
    substrateName: `substrate-${sessionId}`,
    transcriptPath: `/tmp/${sessionId}/session.jsonl`,
    storageDir: `/tmp/${sessionId}`,
    state: 'live',
    updatedAt: new Date().toISOString(),
  });
}

test('attach lease commands are registered under the pinned names', () => {
  assert.equal(SESSION_ATTACH_HEARTBEAT_COMMAND, 'session.attach_heartbeat');
  assert.equal(SESSION_ATTACH_RELEASE_COMMAND, 'session.attach_release');
});

test('effectiveAttachTtl defaults non-positive requests and caps large ones', () => {
  assert.equal(effectiveAttachTtl(undefined), ATTACH_LEASE_DEFAULT_TTL_MS);
  assert.equal(effectiveAttachTtl(0), ATTACH_LEASE_DEFAULT_TTL_MS);
  assert.equal(effectiveAttachTtl(-5_000), ATTACH_LEASE_DEFAULT_TTL_MS);
  assert.equal(effectiveAttachTtl(Number.NaN), ATTACH_LEASE_DEFAULT_TTL_MS);
  assert.equal(effectiveAttachTtl('fast'), ATTACH_LEASE_DEFAULT_TTL_MS);
  assert.equal(effectiveAttachTtl(10_000), 10_000);
  assert.equal(effectiveAttachTtl(ATTACH_LEASE_MAX_TTL_MS), ATTACH_LEASE_MAX_TTL_MS);
  assert.equal(effectiveAttachTtl(ATTACH_LEASE_MAX_TTL_MS + 1), ATTACH_LEASE_MAX_TTL_MS);
  assert.equal(effectiveAttachTtl(9_999_999), ATTACH_LEASE_MAX_TTL_MS);
});

test('heartbeat creates a lease held until lease_until_ms', () => {
  const { leases } = setup();
  const before = Date.now();
  const until = leases.heartbeat('session-1', 'substrate-session-1', 1_000);
  assert.ok(until >= before + 1_000 && until <= Date.now() + 1_000);
  assert.equal(leases.isLeased('session-1', until - 1), true);
});

test('lease lapses exactly at lease_until_ms (strict expiry)', () => {
  const { leases } = setup();
  const until = leases.heartbeat('session-1', 'substrate-session-1', 1_000);
  assert.equal(leases.isLeased('session-1', until), false);
  assert.equal(leases.isLeased('session-1', until + 1), false);
  assert.equal(leases.isLeased('unknown-session', until - 1), false);
});

test('heartbeat refresh extends the lease and defaults the TTL', () => {
  const { leases } = setup();
  const first = leases.heartbeat('session-1', 'substrate-session-1', 1_000);
  const second = leases.heartbeat('session-1', 'substrate-session-1');
  assert.ok(second >= first);
  assert.ok(second - Date.now() <= ATTACH_LEASE_DEFAULT_TTL_MS);
  assert.ok(second - Date.now() > ATTACH_LEASE_DEFAULT_TTL_MS - 5_000);
});

test('prune removes only expired rows and reports the count', () => {
  const { leases } = setup();
  leases.heartbeat('old', 'substrate-old', 50);
  const activeUntil = leases.heartbeat('active', 'substrate-active', 120_000);
  assert.equal(leases.prune(Date.now() + 60_000), 1);
  assert.equal(leases.isLeased('old', Date.now() + 60_000), false);
  assert.equal(leases.isLeased('active', activeUntil - 1), true);
  assert.equal(leases.prune(Date.now() + 60_000), 0);
});

test('heartbeat clamps a huge TTL to the server cap', () => {
  const { leases } = setup();
  const before = Date.now();
  const until = leases.heartbeat('session-1', 'substrate-session-1', 9_999_999);
  assert.ok(until - before <= ATTACH_LEASE_MAX_TTL_MS);
  assert.ok(until - before > ATTACH_LEASE_MAX_TTL_MS - 5_000);
});

test('release drops the lease and is idempotent', () => {
  const { leases } = setup();
  const until = leases.heartbeat('session-1', 'substrate-session-1', 60_000);
  assert.equal(leases.isLeased('session-1', until - 1), true);
  leases.release('session-1');
  assert.equal(leases.isLeased('session-1', until - 1), false);
  leases.release('session-1');
  leases.release('unknown-session');
});

test('heartbeat handler validates the session and defaults the substrate name', () => {
  const { leases, table } = setup();
  assert.throws(
    () => sessionAttachHeartbeat(leases, table, { session_id: 'missing' }),
    /session not found/,
  );
  seedSession(table);
  const result = sessionAttachHeartbeat(leases, table, { session_id: 'session-1' });
  assert.ok(result.lease_until_ms > Date.now());
  assert.equal(leases.isLeased('session-1', result.lease_until_ms - 1), true);
});

test('heartbeat handler honors an explicit substrate name and TTL', () => {
  const { leases } = setup();
  const result = sessionAttachHeartbeat(leases, undefined, {
    session_id: 'session-9',
    substrate_name: 'substrate-session-9',
    ttl_ms: 5_000,
  });
  assert.ok(result.lease_until_ms - Date.now() <= 5_000);
  assert.equal(leases.isLeased('session-9', result.lease_until_ms - 1), true);
});

test('heartbeat handler rejects malformed args and a missing store', () => {
  const { leases, table } = setup();
  assert.throws(
    () => sessionAttachHeartbeat(undefined, table, { session_id: 'x' }),
    /not configured/,
  );
  assert.throws(() => sessionAttachHeartbeat(leases, table, {}), /session_id is required/);
  assert.throws(
    () => sessionAttachHeartbeat(leases, table, { session_id: 'x', ttl_ms: 'fast' }),
    /ttl_ms must be a number/,
  );
});

test('release handler reports whether an active lease was held', () => {
  const { leases, table } = setup();
  seedSession(table);
  sessionAttachHeartbeat(leases, table, { session_id: 'session-1' });
  assert.deepEqual(sessionAttachRelease(leases, { session_id: 'session-1' }), { released: true });
  assert.equal(leases.isLeased('session-1', Date.now()), false);
  assert.deepEqual(sessionAttachRelease(leases, { session_id: 'session-1' }), { released: false });
  assert.deepEqual(sessionAttachRelease(leases, { session_id: 'never-held' }), { released: false });
  assert.throws(() => sessionAttachRelease(undefined, { session_id: 'x' }), /not configured/);
});

test('registerAttachLeases wires both commands and returns the manager spread', () => {
  const { table } = setup();
  seedSession(table);
  const registered = new Map<string, (command: unknown) => unknown>();
  const stores = registerAttachLeases(
    {
      registerCommand: (name: string, handler: (command: unknown) => unknown): void => {
        registered.set(name, handler);
      },
    },
    table,
  );
  assert.equal(registered.has('session.attach_heartbeat'), true);
  assert.equal(registered.has('session.attach_release'), true);
  assert.equal('attachLeases' in stores, true);
  const heartbeat = registered.get('session.attach_heartbeat');
  const release = registered.get('session.attach_release');
  assert.ok(heartbeat && release);
  const heartbeatResult = heartbeat({ session_id: 'session-1' });
  if (
    typeof heartbeatResult !== 'object' ||
    heartbeatResult === null ||
    !('lease_until_ms' in heartbeatResult)
  )
    throw new Error('heartbeat must return lease_until_ms');
  const leaseUntilMs = heartbeatResult.lease_until_ms;
  if (typeof leaseUntilMs !== 'number') throw new Error('lease_until_ms must be a number');
  assert.ok(leaseUntilMs > Date.now());
  const releaseResult = release({ session_id: 'session-1' });
  if (typeof releaseResult !== 'object' || releaseResult === null || !('released' in releaseResult))
    throw new Error('release must return released');
  assert.equal(releaseResult.released, true);
  if (!('attachLeases' in stores)) throw new Error('stores carry no attach leases');
  assert.equal(typeof stores.attachLeases.isLeased, 'function');
  assert.equal(typeof stores.attachLeases.prune, 'function');
});

test('registerAttachLeases without a table registers nothing and spreads empty', () => {
  const registered = new Map<string, (command: unknown) => unknown>();
  const stores = registerAttachLeases(
    {
      registerCommand: (name: string, handler: (command: unknown) => unknown): void => {
        registered.set(name, handler);
      },
    },
    undefined,
  );
  assert.equal(registered.size, 0);
  assert.deepEqual({ ...stores }, {});
});

test('attach lease transports post to the pinned command names', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requests.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => ({ value: { lease_until_ms: 1_234, released: true } }),
    };
  }) as typeof fetch;
  try {
    await postSessionAttachHeartbeat('http://loopback', { session_id: 'session-1' });
    await postSessionAttachRelease('http://loopback', { session_id: 'session-1' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests, [
    'http://loopback/commands/session.attach_heartbeat',
    'http://loopback/commands/session.attach_release',
  ]);
});

test('createClient exposes bound attach lease methods for structural callers', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requests.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => ({ value: { lease_until_ms: 1_234, released: true } }),
    };
  }) as typeof fetch;
  try {
    const client = createClient({ baseUrl: 'http://loopback' });
    await client.sessionAttachHeartbeat?.({ session_id: 'session-1' });
    await client.sessionAttachRelease?.({ session_id: 'session-1' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests, [
    'http://loopback/commands/session.attach_heartbeat',
    'http://loopback/commands/session.attach_release',
  ]);
});
