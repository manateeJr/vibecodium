import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntervalHistogram } from 'node:perf_hooks';
import { EventStore } from '../src/server/event-store.js';
import { eventLoopProbe, eventStoreProbe } from '../src/server/core-probes.js';
import { ProbeRunner } from '../src/server/probe-runner.js';

test('probe runner times out a slow probe without blocking a fast probe', async () => {
  const runner = new ProbeRunner();
  runner.register('slow', () => new Promise<never>(() => undefined), { timeoutMs: 20 });
  runner.register('fast', () => ({ status: 'healthy', metrics: { answer: 42 } }));

  const started = Date.now();
  const result = await runner.run();
  const elapsed = Date.now() - started;

  assert.equal(result.status, 'wedged');
  assert.equal(result.probes.find((probe) => probe.name === 'slow')?.detail, 'probe timeout');
  assert.equal(result.probes.find((probe) => probe.name === 'fast')?.status, 'healthy');
  assert.ok(elapsed < 250);
});

test('event-loop probe applies mean-delay thresholds', () => {
  const histogram = (meanMs: number): IntervalHistogram =>
    ({
      mean: meanMs * 1_000_000,
      max: meanMs * 1_000_000,
      percentile: () => meanMs * 1_000_000,
    }) as unknown as IntervalHistogram;

  assert.equal(eventLoopProbe(histogram(100)).status, 'healthy');
  assert.equal(eventLoopProbe(histogram(100.001)).status, 'degraded');
  assert.equal(eventLoopProbe(histogram(1_000.001)).status, 'wedged');
});

test('event-store probe reports count and latest sequence, and degrades on failure', () => {
  const store = new EventStore({ filename: ':memory:' });
  try {
    assert.deepEqual(eventStoreProbe(store), {
      status: 'healthy',
      metrics: { events: 0, lastSeq: 0 },
    });
    store.append('probe', 'session_started', { session_id: 'probe', provider: 'fake', prompt: '' });
    assert.deepEqual(eventStoreProbe(store), {
      status: 'healthy',
      metrics: { events: 1, lastSeq: 1 },
    });
  } finally {
    store.close();
  }
  assert.equal(eventStoreProbe(store).status, 'degraded');
});
