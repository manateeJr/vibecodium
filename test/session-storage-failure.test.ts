import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateSessionStorage } from '../src/session/session-storage.js';
import { SessionTable } from '../src/session/session-table.js';

function record(sessionId: string, storageDir: string) {
  return {
    sessionId,
    provider: 'omp',
    harnessRef: `harness-${sessionId}`,
    substrateName: `substrate-${sessionId}`,
    transcriptPath: path.join(storageDir, 'session.jsonl'),
    storageDir,
    state: 'resumable' as const,
    updatedAt: '2026-08-30T00:00:00.000Z',
    label: '',
    origin: 'agent' as const,
  };
}

test('one legacy migration failure is warned and does not block other sessions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-storage-failure-'));
  const oldRoot = path.join(root, 'old');
  const newRoot = path.join(root, 'new');
  const blockedSource = path.join(oldRoot, 'blocked');
  const movedSource = path.join(oldRoot, 'moved');
  const blockedDestination = path.join(newRoot, 'blocked');
  const table = new SessionTable({ filename: ':memory:' });
  table.upsert(record('blocked', blockedSource));
  table.upsert(record('moved', movedSource));
  mkdirSync(blockedSource, { recursive: true });
  mkdirSync(movedSource, { recursive: true });
  mkdirSync(blockedDestination, { recursive: true });
  appendFileSync(path.join(blockedSource, 'session.jsonl'), 'blocked\n');
  appendFileSync(path.join(movedSource, 'session.jsonl'), 'moved\n');
  const warnings: string[] = [];

  try {
    const summary = await migrateSessionStorage(table, {
      storageRoot: newRoot,
      oldRoots: [oldRoot],
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(summary, { migrated: 1, missing: 0, skipped: 1 });
    assert.equal(existsSync(blockedSource), true);
    assert.equal(existsSync(path.join(newRoot, 'moved', 'session.jsonl')), true);
    assert.equal(table.get('blocked')?.storageDir, blockedSource);
    assert.equal(table.get('moved')?.storageDir, path.join(newRoot, 'moved'));
    assert.equal(warnings.length, 1);
  } finally {
    table.close();
    rmSync(root, { recursive: true, force: true });
  }
});
