import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyHealth,
  createHealthMonitor,
  deriveStatus,
  wireConnectivity,
} from './connectivity.js';

test('classifies health responses and failures', () => {
  assert.equal(classifyHealth({ response: { status: 200, ok: true } }), 'healthy');
  assert.equal(classifyHealth({ response: { status: 503, ok: false } }), 'wedged');
  assert.equal(classifyHealth({ response: { status: 200, ok: false } }), 'wedged');
  assert.equal(classifyHealth({ timedOut: true }), 'wedged');
  assert.equal(classifyHealth({ error: new Error('network') }), 'down');
  assert.equal(classifyHealth({ error: { name: 'AbortError' } }), 'wedged');
});

test('health monitor polls healthz and enforces its timeout', async () => {
  const healthyStates = [];
  let resolveHealthy;
  const healthySeen = new Promise((resolve) => {
    resolveHealthy = resolve;
  });
  const healthyMonitor = createHealthMonitor({
    baseUrl: 'http://control-plane.test/',
    intervalMs: 60_000,
    fetchImpl: async (url, init) => {
      healthyStates.push({ url, init });
      return { status: 200, ok: true };
    },
    onState: (state) => {
      healthyStates.push(state);
      if (state === 'healthy') resolveHealthy();
    },
  });
  await healthySeen;
  healthyMonitor.stop();
  assert.equal(healthyStates[0].url, 'http://control-plane.test/healthz');
  assert.equal(healthyStates[0].init.method, 'GET');

  const wedgedStates = [];
  let resolveWedged;
  const wedgedSeen = new Promise((resolve) => {
    resolveWedged = resolve;
  });
  let aborted = false;
  const wedgedMonitor = createHealthMonitor({
    baseUrl: 'http://control-plane.test',
    intervalMs: 60_000,
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
          { once: true },
        );
      }),
    onState: (state) => {
      wedgedStates.push(state);
      if (state === 'wedged') resolveWedged();
    },
  });
  await Promise.race([
    wedgedSeen,
    new Promise((_, reject) =>
      globalThis.setTimeout(() => reject(new Error('health timeout test hung')), 100),
    ),
  ]);
  wedgedMonitor.stop();
  assert.deepEqual(wedgedStates, ['wedged']);
  assert.equal(aborted, true);
});

test('derives the worst truthful connection badge', () => {
  assert.deepEqual(
    deriveStatus({ health: 'down', selected: true, online: false, reconnecting: true }),
    { label: 'DOWN', tone: 'bad' },
  );
  assert.deepEqual(deriveStatus({ health: 'wedged', selected: true, online: true }), {
    label: 'WEDGED',
    tone: 'bad',
  });
  assert.deepEqual(deriveStatus({ health: 'healthy', selected: true }), {
    label: 'LIVE',
    tone: 'live',
  });
  assert.deepEqual(deriveStatus({ health: 'healthy', selected: false }), {
    label: 'READY',
    tone: 'idle',
  });
  assert.deepEqual(deriveStatus({ health: 'unknown', selected: false, online: false }), {
    label: 'OFFLINE',
    tone: 'bad',
  });
  assert.deepEqual(deriveStatus({ health: 'healthy', selected: true, online: false }), {
    label: 'OFFLINE',
    tone: 'bad',
  });
});

test('reconnect and visibility events reload every drawer source', () => {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const eventTarget = {
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    emit(type) {
      windowListeners.get(type)?.();
    },
  };
  const documentTarget = {
    visibilityState: 'visible',
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    emit(type) {
      documentListeners.get(type)?.();
    },
  };
  const loads = { live: 0, recent: 0, machine: 0 };
  let reconnects = 0;
  let hydrates = 0;
  wireConnectivity({
    setStatus: () => undefined,
    getSelected: () => 'session:selected',
    hydrate: () => {
      hydrates += 1;
    },
    reconnect: () => {
      reconnects += 1;
    },
    reload: () => {
      loads.live += 1;
      loads.recent += 1;
      loads.machine += 1;
    },
    eventTarget,
    documentTarget,
    isOnline: () => true,
    serviceWorker: undefined,
  });

  eventTarget.emit('online');
  documentTarget.emit('visibilitychange');

  assert.deepEqual(loads, { live: 2, recent: 2, machine: 2 });
  assert.equal(reconnects, 2);
  assert.equal(hydrates, 2);
});
