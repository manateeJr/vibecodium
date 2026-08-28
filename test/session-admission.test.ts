import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import {
  admissionConfigFromEnv,
  AdmissionBudget,
  SessionThrottledError,
} from '../src/session/admission.js';
import { SessionSubsystem } from '../src/session/index.js';

type RegisteredCommand = (command: unknown) => unknown | Promise<unknown>;

class FakeContext implements SubsystemContext {
  public readonly events: EventEnvelope[] = [];
  public readonly commands = new Map<string, RegisteredCommand>();
  private readonly projectors = new Map<string, EventHandler>();
  private readonly listeners = new Map<string, EventHandler>();
  private readonly subscribers = new Set<EventHandler>();
  private nextSequence = 1;

  public registerProjector(name: string, onEvent: EventHandler, from_seq = 0): void {
    this.projectors.set(name, onEvent);
    for (const event of this.events) if (event.seq > from_seq) onEvent(event);
  }

  public registerCommand(name: string, handler: RegisteredCommand): void {
    this.commands.set(name, handler);
  }

  public registerListener(name: string, handler: EventHandler): void {
    this.listeners.set(name, handler);
  }

  public subscribe(from_seq: number, onEvent: EventHandler): () => void {
    for (const event of this.events) if (event.seq > from_seq) onEvent(event);
    this.subscribers.add(onEvent);
    return () => this.subscribers.delete(onEvent);
  }

  public append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number {
    const event: EventEnvelope<K> = {
      stream_id,
      seq: this.nextSequence,
      type,
      payload,
      ts: new Date(0).toISOString(),
    };
    this.nextSequence += 1;
    this.events.push(event);
    for (const projector of this.projectors.values()) projector(event);
    for (const listener of this.listeners.values()) listener(event);
    for (const subscriber of this.subscribers) subscriber(event);
    return event.seq;
  }
}

class NeverCompletingWorker extends EventEmitter {
  public connected = true;
  public killed = false;

  public send(_message: unknown, callback?: (error?: Error | null) => void): boolean {
    callback?.();
    return true;
  }

  public kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }
}

test('AdmissionBudget enforces the concurrent-session limit', () => {
  const budget = new AdmissionBudget({ maxConcurrent: 2, rateMax: 100, rateWindowMs: 1000 });
  assert.deepEqual(budget.tryAdmit(0), { ok: true });
  assert.deepEqual(budget.tryAdmit(1), { ok: true });
  assert.deepEqual(budget.tryAdmit(2), { ok: false, reason: 'concurrency', limit: 2 });
});

test('AdmissionBudget enforces the successful-admission rate window', () => {
  let now = 0;
  const budget = new AdmissionBudget({
    maxConcurrent: 100,
    rateMax: 2,
    rateWindowMs: 1000,
    now: () => now,
  });
  assert.deepEqual(budget.tryAdmit(0), { ok: true });
  assert.deepEqual(budget.tryAdmit(0), { ok: true });
  const denied = budget.tryAdmit(0);
  assert.equal(denied.ok, false);
  if (denied.ok) throw new Error('expected rate denial');
  assert.equal(denied.reason, 'rate');
  assert.equal(denied.limit, 2);
  assert.ok((denied.retry_after_ms ?? 0) > 0);
  now = 1001;
  assert.deepEqual(budget.tryAdmit(0), { ok: true });
});

test('admissionConfigFromEnv applies defaults and positive overrides', () => {
  assert.deepEqual(admissionConfigFromEnv({}), {
    maxConcurrent: 3,
    rateMax: 20,
    rateWindowMs: 60000,
  });
  assert.deepEqual(
    admissionConfigFromEnv({
      VIBECODIUM_MAX_CONCURRENT_SESSIONS: '7',
      VIBECODIUM_SESSION_RATE_MAX: '40',
      VIBECODIUM_SESSION_RATE_WINDOW_MS: '120000',
    }),
    { maxConcurrent: 7, rateMax: 40, rateWindowMs: 120000 },
  );
  assert.deepEqual(
    admissionConfigFromEnv({
      VIBECODIUM_MAX_CONCURRENT_SESSIONS: '0',
      VIBECODIUM_SESSION_RATE_MAX: 'not-a-number',
      VIBECODIUM_SESSION_RATE_WINDOW_MS: '-1',
    }),
    { maxConcurrent: 3, rateMax: 20, rateWindowMs: 60000 },
  );
});

test('SessionSubsystem emits throttling before rejecting and admits after stop', async () => {
  const context = new FakeContext();
  const workers: NeverCompletingWorker[] = [];
  const ids = ['session-1', 'session-2'];
  const subsystem = new SessionSubsystem({
    admission: new AdmissionBudget({ maxConcurrent: 1, rateMax: 100, rateWindowMs: 60000 }),
    idFactory: () => ids.shift() ?? 'unexpected-session',
    fork: () => {
      const worker = new NeverCompletingWorker();
      workers.push(worker);
      return worker as unknown as ChildProcess;
    },
  });
  subsystem.register(context);

  const first = await subsystem.open({ provider: 'fake', prompt: 'first' });
  assert.equal(workers.length, 1);
  await assert.rejects(subsystem.open({ provider: 'fake', prompt: 'second' }), (error: unknown) => {
    assert.ok(error instanceof SessionThrottledError);
    assert.equal(error.reason, 'concurrency');
    assert.equal(error.limit, 1);
    assert.equal(error.retry_after_ms, undefined);
    assert.equal(error.message, 'session throttled: concurrency limit 1 reached');
    return true;
  });

  const throttled = context.events.find((event) => (event.type as string) === 'session_throttled');
  assert.ok(throttled);
  assert.equal(throttled.stream_id, 'admission');
  assert.deepEqual(throttled.payload, { provider: 'fake', reason: 'concurrency', limit: 1 });

  assert.deepEqual(await subsystem.stop({ session_id: first.session_id }), { stopped: true });
  const reopened = await subsystem.open({ provider: 'fake', prompt: 'third' });
  assert.equal(reopened.session_id, 'session-2');
  assert.equal(workers.length, 2);
});
