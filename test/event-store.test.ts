import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EventEnvelope } from '../src/contracts/events.js';
import { EventStore } from '../src/server/event-store.js';

test('append assigns monotonic global sequences and replays after a cursor', () => {
  const store = new EventStore({ filename: ':memory:' });
  const first = store.append('session:a', 'session_started', {
    session_id: 'a',
    provider: 'fake',
    prompt: 'hello',
  });
  const otherStream = store.append('session:b', 'session_started', {
    session_id: 'b',
    provider: 'fake',
    prompt: 'hello',
  });
  const third = store.append('session:a', 'session_output', {
    session_id: 'a',
    index: 0,
    text: 'hello',
  });

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
  store.append('session:a', 'session_started', {
    session_id: 'a',
    provider: 'fake',
    prompt: 'hello',
  });
  const received: number[] = [];
  const unsubscribe = store.subscribe('session:a', 0, (event) => received.push(event.seq));
  store.append('session:a', 'session_output', {
    session_id: 'a',
    index: 0,
    text: 'one',
  });
  store.append('session:a', 'session_complete', { session_id: 'a', provider: 'fake' });
  unsubscribe();
  store.append('session:a', 'session_output', {
    session_id: 'a',
    index: 1,
    text: 'ignored',
  });

  assert.deepEqual(received, [1, 2, 3]);
  store.close();
});

test('events survive closing and reopening the SQLite store', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-events-'));
  const filename = path.join(directory, 'events.sqlite');
  const firstStore = new EventStore({ filename });
  firstStore.append('session:a', 'session_started', {
    session_id: 'a',
    provider: 'fake',
    prompt: 'hello',
  });
  firstStore.close();

  const reopened = new EventStore({ filename });
  assert.deepEqual(
    (reopened.read('session:a', 0) as EventEnvelope[]).map((event) => event.payload),
    [{ session_id: 'a', provider: 'fake', prompt: 'hello' }],
  );
  reopened.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
