import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_SESSION_STORAGE_ROOT } from '../src/session/index.js';
import {
  legacySessionStorageRoots,
  migrateSessionStorage,
  sessionStorageRootFromEnvironment,
} from '../src/session/session-storage.js';
import { SessionTable } from '../src/session/session-table.js';

function sessionRecord(
  sessionId: string,
  storageDir: string,
  transcriptPath: string,
  state: 'live' | 'resumable' | 'closed' = 'resumable',
) {
  return {
    sessionId,
    provider: 'omp',
    harnessRef: `harness-${sessionId}`,
    substrateName: `substrate-${sessionId}`,
    transcriptPath,
    storageDir,
    state,
    label: '',
    origin: 'agent' as const,
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

test('session storage root honors an explicit env override and HOME default', () => {
  const home = '/tmp/vibecodium-session-home';
  assert.equal(
    sessionStorageRootFromEnvironment({ HOME: home }),
    path.join(home, '.vibecodium', 'sessions'),
  );
  assert.equal(
    sessionStorageRootFromEnvironment({
      HOME: home,
      VIBECODIUM_SESSION_STORAGE_ROOT: '/var/lib/vibecodium/sessions',
    }),
    '/var/lib/vibecodium/sessions',
  );
  assert.equal(DEFAULT_SESSION_STORAGE_ROOT, sessionStorageRootFromEnvironment());
});

test('legacy roots include tmp and cache roots for the supplied environment', () => {
  const roots = legacySessionStorageRoots({ HOME: '/tmp/vibecodium-home', TMPDIR: '/tmp/work' });
  assert.deepEqual(roots, [
    '/tmp/work/vibecodium-sessions',
    '/tmp/vibecodium-home/.cache/vibecodium-sessions',
  ]);
});

test('startup migration moves a legacy session and rewrites both durable paths', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-storage-home-'));
  const oldRoot = path.join(home, '.cache', 'vibecodium-sessions');
  const newRoot = path.join(home, '.vibecodium', 'sessions');
  const sessionId = 'legacy-session';
  const oldStorageDir = path.join(oldRoot, sessionId);
  const oldTranscriptPath = path.join(oldStorageDir, 'session.jsonl');
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert(sessionRecord(sessionId, oldStorageDir, oldTranscriptPath));
  mkdirSync(oldStorageDir, { recursive: true });
  appendFileSync(oldTranscriptPath, '{"message":"hello"}\n');

  try {
    const summary = await migrateSessionStorage(table, {
      storageRoot: newRoot,
      oldRoots: [oldRoot],
      now: () => new Date('2026-08-31T01:02:03.000Z'),
    });
    const migrated = table.get(sessionId);
    const newStorageDir = path.join(newRoot, sessionId);
    const newTranscriptPath = path.join(newStorageDir, 'session.jsonl');
    assert.deepEqual(summary, { migrated: 1, missing: 0, skipped: 0 });
    assert.equal(existsSync(oldStorageDir), false);
    assert.equal(existsSync(newTranscriptPath), true);
    assert.equal(migrated?.storageDir, newStorageDir);
    assert.equal(migrated?.transcriptPath, newTranscriptPath);
    assert.equal(migrated?.state, 'resumable');

    const secondSummary = await migrateSessionStorage(table, {
      storageRoot: newRoot,
      oldRoots: [oldRoot],
      now: () => new Date('2026-08-31T01:02:04.000Z'),
    });
    assert.deepEqual(secondSummary, { migrated: 0, missing: 0, skipped: 0 });
    assert.deepEqual(table.get(sessionId), migrated);
  } finally {
    table.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('startup migration closes a resumable record when its legacy directory is gone', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-storage-gone-'));
  const oldRoot = path.join(home, '.cache', 'vibecodium-sessions');
  const newRoot = path.join(home, '.vibecodium', 'sessions');
  const sessionId = 'gone-session';
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert(
    sessionRecord(
      sessionId,
      path.join(oldRoot, sessionId),
      path.join(oldRoot, sessionId, 'session.jsonl'),
    ),
  );

  try {
    const summary = await migrateSessionStorage(table, {
      storageRoot: newRoot,
      oldRoots: [oldRoot],
      now: () => new Date('2026-08-31T02:03:04.000Z'),
    });
    assert.deepEqual(summary, { migrated: 0, missing: 1, skipped: 0 });
    assert.equal(table.get(sessionId)?.state, 'closed');
    assert.equal(table.get(sessionId)?.updatedAt, '2026-08-31T02:03:04.000Z');

    const secondSummary = await migrateSessionStorage(table, {
      storageRoot: newRoot,
      oldRoots: [oldRoot],
      now: () => new Date('2026-08-31T02:03:05.000Z'),
    });
    assert.deepEqual(secondSummary, { migrated: 0, missing: 0, skipped: 0 });
  } finally {
    table.close();
    rmSync(home, { recursive: true, force: true });
  }
});
