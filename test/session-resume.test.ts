import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { AdmissionBudget } from '../src/session/admission.js';
import { SessionSubsystem } from '../src/session/index.js';

class FakeWorker extends EventEmitter {
  public connected = true;
  public killed = false;
  public readonly messages: unknown[] = [];

  public send(message: unknown, callback?: (error?: Error | null) => void): boolean {
    this.messages.push(message);
    callback?.();
    return true;
  }

  public kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }
}

class FakeContext implements SubsystemContext {
  public readonly events: EventEnvelope[] = [];
  public readonly commands = new Map<string, CommandHandler>();
  private nextSequence = 1;

  public registerProjector(): void {}

  public registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  public registerListener(): void {}

  public subscribe(): () => void {
    return () => undefined;
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
    return event.seq;
  }
}

test('session.resume admits, records, and forwards the provider resume reference', async () => {
  const context = new FakeContext();
  const worker = new FakeWorker();
  const subsystem = new SessionSubsystem({
    admission: new AdmissionBudget({ maxConcurrent: 1, rateMax: 10, rateWindowMs: 1000 }),
    idFactory: () => 'resumed-session',
    fork: () => worker as unknown as ChildProcess,
  });
  subsystem.register(context);

  const result = await context.commands.get(COMMAND_NAMES.sessionResume)?.({
    source: 'omp',
    ref: 'omp-session-ref',
    prompt: 'continue the old conversation',
    cwd: '/workspace',
  });

  assert.deepEqual(result, {
    session_id: 'resumed-session',
    stream_id: 'session:resumed-session',
  });
  assert.deepEqual(context.events[0]?.payload, {
    session_id: 'resumed-session',
    provider: 'omp',
    prompt: 'continue the old conversation',
    cwd: '/workspace',
  });
  assert.deepEqual(worker.messages[0], {
    type: 'start',
    session_id: 'resumed-session',
    stream_id: 'session:resumed-session',
    provider: 'omp',
    prompt: 'continue the old conversation',
    cwd: '/workspace',
    resumeRef: 'omp-session-ref',
  });

  assert.deepEqual(await subsystem.stop({ session_id: 'resumed-session' }), { stopped: true });
});
