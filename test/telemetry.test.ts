import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EventEnvelope } from '../src/contracts/events.js';
import type { TelemetrySignatureRow } from '../src/contracts/telemetry-schema.js';
import type { EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { ControlPlane } from '../src/server/control-plane.js';
import {
  createTelemetrySubsystem,
  TELEMETRY_PROJECTOR_NAME,
  TELEMETRY_RECORD_COMMAND,
  TelemetryStore,
} from '../src/telemetry/index.js';

function verifyFailedEvent(
  seq: number,
  stream_id: string,
  error_class = 'TypeError',
  stage = 'verify',
): EventEnvelope<'verify_failed'> {
  return {
    stream_id,
    seq,
    type: 'verify_failed',
    payload: { stage, error: `${error_class}: bad output`, error_class },
    ts: new Date(seq * 1_000).toISOString(),
  };
}

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telemetry-'));
}

test('folds matching failures and only returns signatures at the threshold', () => {
  const directory = temporaryDirectory();
  const store = new TelemetryStore({ filename: path.join(directory, 'telemetry.db') });
  try {
    store.projectEvent(verifyFailedEvent(1, 'session:1'));
    store.projectEvent(verifyFailedEvent(2, 'session:2', 'TypeError'));
    store.projectEvent(verifyFailedEvent(3, 'session:3', 'TypeError'));
    const recurring = store.queryRecurringSignatures();
    assert.equal(recurring.length, 1);
    assert.equal(recurring[0]?.occurrences, 3);
    assert.equal(recurring[0]?.status, 'open');
    assert.equal(store.queryRecurringSignatures(4).length, 0);
    assert.equal(store.queryRecurringSignatures(2)[0]?.signature, recurring[0]?.signature);
    const signature = recurring[0]?.signature;
    assert.ok(signature);
    assert.equal(store.setSignatureStatus(signature, 'resolved'), true);
    assert.equal(store.queryRecurringSignatures().length, 1);
    assert.equal(store.queryRecurringSignatures(3, 'open').length, 0);
    assert.equal(store.queryRecurringSignatures(3, 'resolved').length, 1);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rebuilds an identical projection by replaying the global event cursor', async () => {
  const directory = temporaryDirectory();
  const eventPath = path.join(directory, 'events.sqlite');
  const telemetryPath = path.join(directory, 'telemetry.db');
  const firstSubsystem = createTelemetrySubsystem({ filename: telemetryPath });
  const firstControlPlane = new ControlPlane({ dataPath: eventPath, subsystems: [firstSubsystem] });
  let expectedRows: TelemetrySignatureRow[] = [];
  try {
    firstControlPlane.context.append('session:1', 'verify_failed', {
      stage: 'verify',
      error: 'TypeError: bad output',
      error_class: 'TypeError',
    });
    firstControlPlane.context.append('session:2', 'verify_failed', {
      stage: 'verify',
      error: 'TypeError: different detail',
      error_class: 'TypeError',
    });
    firstControlPlane.context.append('session:3', 'verify_failed', {
      stage: 'verify',
      error: 'TypeError: another detail',
      error_class: 'TypeError',
    });
    expectedRows = firstSubsystem.store.queryRecurringSignatures();
    assert.equal(expectedRows[0]?.occurrences, 3);
  } finally {
    await firstControlPlane.stop();
    firstSubsystem.store.close();
  }

  fs.rmSync(telemetryPath, { force: true });
  const rebuiltSubsystem = createTelemetrySubsystem({ filename: telemetryPath, from_seq: 0 });
  const rebuiltControlPlane = new ControlPlane({
    dataPath: eventPath,
    subsystems: [rebuiltSubsystem],
  });
  try {
    assert.deepEqual(rebuiltSubsystem.store.queryRecurringSignatures(), expectedRows);
  } finally {
    await rebuiltControlPlane.stop();
    rebuiltSubsystem.store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('record command appends only and does not write telemetry directly', () => {
  const directory = temporaryDirectory();
  const subsystem = createTelemetrySubsystem({ filename: path.join(directory, 'telemetry.db') });
  let commandName = '';
  let commandHandler: ((command: unknown) => unknown | Promise<unknown>) | undefined;
  const appendCalls: Array<{
    stream_id: string;
    type: string;
    payload: unknown;
  }> = [];
  const ctx: SubsystemContext = {
    registerProjector(name: string, onEvent: EventHandler): void {
      assert.equal(name, TELEMETRY_PROJECTOR_NAME);
      void onEvent;
    },
    registerCommand(name, handler): void {
      commandName = name;
      commandHandler = handler;
    },
    registerListener(): void {
      throw new Error('telemetry must not register a listener');
    },
    append(stream_id, type, payload): number {
      assert.equal(type, 'verify_failed');
      appendCalls.push({ stream_id, type, payload });
      return 17;
    },
    subscribe(): () => void {
      throw new Error('telemetry must not subscribe directly');
    },
  };

  try {
    subsystem.register(ctx);
    assert.equal(commandName, TELEMETRY_RECORD_COMMAND);
    assert.ok(commandHandler);
    const result = commandHandler?.({
      stream_id: 'session:command',
      stage: 'verify',
      error: 'TypeError: bad output',
      error_class: 'TypeError',
    });
    assert.equal(result, 17);
    assert.deepEqual(appendCalls, [
      {
        stream_id: 'session:command',
        type: 'verify_failed',
        payload: {
          stage: 'verify',
          error: 'TypeError: bad output',
          error_class: 'TypeError',
        },
      },
    ]);
    assert.equal(subsystem.store.eventCount(), 0);
  } finally {
    subsystem.store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
