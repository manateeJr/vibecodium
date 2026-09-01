import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const watchdog = await import(
  pathToFileURL(path.join(repositoryRoot, 'scripts/watchdog.mjs')).href
);
const options = { failureThreshold: 3, cooldownMs: 100 };
const initialState = { consecutiveFailures: 0, lastRestartAt: null };

function failure(timestampMs: number) {
  return { ok: false, timestampMs };
}

function recovery(timestampMs: number) {
  return { ok: true, timestampMs };
}

test('watchdog fires snapshot and restart after the failure threshold', () => {
  const decision = watchdog.decideWatchdogAction([failure(0), failure(10), failure(20)], options);
  assert.deepEqual(decision, { snapshot: true, restart: true });
});

test('watchdog respects cooldown and resets after recovery', () => {
  let state = initialState;
  state = watchdog.advanceWatchdog(state, failure(0), options).state;
  state = watchdog.advanceWatchdog(state, failure(10), options).state;
  const first = watchdog.advanceWatchdog(state, failure(20), options);
  assert.deepEqual(first, {
    snapshot: true,
    restart: true,
    state: { consecutiveFailures: 0, lastRestartAt: 20 },
  });

  const duringCooldown = watchdog.advanceWatchdog(first.state, failure(30), options);
  assert.equal(duringCooldown.snapshot, false);
  assert.equal(duringCooldown.restart, false);
  assert.equal(duringCooldown.state.consecutiveFailures, 1);

  const recovered = watchdog.advanceWatchdog(duringCooldown.state, recovery(40), options);
  assert.deepEqual(recovered.state, { consecutiveFailures: 0, lastRestartAt: 20 });

  let afterCooldown = recovered.state;
  afterCooldown = watchdog.advanceWatchdog(afterCooldown, failure(121), options).state;
  afterCooldown = watchdog.advanceWatchdog(afterCooldown, failure(130), options).state;
  const second = watchdog.advanceWatchdog(afterCooldown, failure(140), options);
  assert.equal(second.snapshot, true);
  assert.equal(second.restart, true);
});
