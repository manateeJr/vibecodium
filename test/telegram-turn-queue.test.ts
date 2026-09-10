import assert from 'node:assert/strict';
import test from 'node:test';
import { TURN_QUEUE_CAP, TurnQueue } from '../src/telegram/turn-queue.js';

test('turn queue preserves FIFO order per thread', () => {
  const queue = new TurnQueue();
  assert.deepEqual(queue.enqueue(7, 'first'), { queued: true, position: 1 });
  assert.deepEqual(queue.enqueue(7, 'second'), { queued: true, position: 2 });
  assert.deepEqual(queue.enqueue(7, 'third'), { queued: true, position: 3 });
  assert.equal(queue.dequeue(7), 'first');
  assert.equal(queue.dequeue(7), 'second');
  assert.equal(queue.dequeue(7), 'third');
  assert.equal(queue.dequeue(7), undefined);
});

test('turn queue caps at five prompts per thread', () => {
  const queue = new TurnQueue();
  for (let index = 1; index <= TURN_QUEUE_CAP; index += 1) {
    assert.deepEqual(queue.enqueue(9, `prompt ${index}`), { queued: true, position: index });
  }
  assert.deepEqual(queue.enqueue(9, 'overflow'), { queued: false, reason: 'full' });
  assert.equal(queue.size(9), TURN_QUEUE_CAP);
});

test('turn queue keeps mixed text and voice prompt strings in order', () => {
  const queue = new TurnQueue();
  const voicePrompt = 'caption here\ntranscribed voice text';
  assert.deepEqual(queue.enqueue(11, 'text prompt'), { queued: true, position: 1 });
  assert.deepEqual(queue.enqueue(11, voicePrompt), { queued: true, position: 2 });
  assert.equal(queue.dequeue(11), 'text prompt');
  assert.equal(queue.dequeue(11), voicePrompt);
});

test('turn queue clear drops a thread queue like /stop', () => {
  const queue = new TurnQueue();
  queue.enqueue(13, 'first');
  queue.enqueue(13, 'second');
  queue.clear(13);
  assert.equal(queue.size(13), 0);
  assert.equal(queue.dequeue(13), undefined);
  assert.deepEqual(queue.enqueue(13, 'after stop'), { queued: true, position: 1 });
});
