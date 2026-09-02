import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openTopicStore } from '../src/telegram/store.js';
import type { TopicBinding } from '../src/telegram/types.js';

test('topic store renames bindings and persists the label', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-store-rename-'));
  const filename = path.join(directory, 'telegram.sqlite');
  const binding: TopicBinding = {
    threadId: 77,
    sessionId: 'session-1',
    label: 'old label',
    createdAt: new Date(0).toISOString(),
  };
  const renamed = { ...binding, label: 'new label' };

  try {
    const first = openTopicStore(filename);
    first.bind(binding);
    first.rename(binding.threadId, renamed.label);
    assert.deepEqual(first.byThread(binding.threadId), renamed);
    assert.deepEqual(first.all(), [renamed]);
    first.rename(999, 'unknown label');
    assert.deepEqual(first.all(), [renamed]);
    first.close();

    const second = openTopicStore(filename);
    try {
      assert.deepEqual(second.byThread(binding.threadId), renamed);
      assert.deepEqual(second.all(), [renamed]);
      assert.equal(second.byThread(999), null);
    } finally {
      second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
