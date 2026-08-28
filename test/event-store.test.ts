import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventStore } from '../src/server/event-store.js';

test('append assigns monotonic global sequences and replays after a cursor', () => {
  const store = new EventStore({ filename: ':memory:' });
  const first = store.append('session:a', 'opened', { id: 'a' });
  const otherStream = store.append('session:b', 'opened', { id: 'b' });
  const third = store.append('session:a', 'output', { text: 'hello' });

  assert.deepEqual([first, otherStream, third], [1, 2, 3]);
  assert.deepEqual(
    store.read('session:a', 0).map((event) => event.seq),
    [1, 3],
  );
  assert.deepEqual(
    store.read('session:a', first).map((event) => event.seq),
    [3],
  );
  store.close();
});

test('subscribe replays the cursor then receives newly appended events', () => {
  const store = new EventStore({ filename: ':memory:' });
  store.append('session:a', 'opened', { id: 'a' });
  const received: number[] = [];
  const unsubscribe = store.subscribe('session:a', 0, (event) => received.push(event.seq));
  store.append('session:a', 'output', { text: 'one' });
  store.append('session:a', 'completed', {});
  unsubscribe();
  store.append('session:a', 'ignored', {});

  assert.deepEqual(received, [1, 2, 3]);
  store.close();
});

test('events survive closing and reopening the SQLite store', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-events-'));
  const filename = path.join(directory, 'events.sqlite');
  const firstStore = new EventStore({ filename });
  firstStore.append('session:a', 'opened', { id: 'a' });
  firstStore.close();

  const reopened = new EventStore({ filename });
  assert.deepEqual(
    reopened.read('session:a', 0).map((event) => event.payload),
    [{ id: 'a' }],
  );
  reopened.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
