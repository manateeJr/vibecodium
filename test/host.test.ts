import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { EventKind, EventPayload } from '../src/contracts/events.js';
import type { SubsystemContext } from '../src/contracts/subsystem.js';
import { createHostSubsystem } from '../src/host/index.js';
import { AdmissionBudget, admissionConfigFromEnv } from '../src/session/admission.js';
import { EventStore } from '../src/server/event-store.js';

type RegisteredCommand = (command: unknown) => unknown | Promise<unknown>;

function contextFor(store: EventStore, commands: Map<string, RegisteredCommand>): SubsystemContext {
  return {
    registerProjector: () => undefined,
    registerCommand: (name, handler) => commands.set(name, handler),
    registerListener: () => undefined,
    append: <K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number =>
      store.append(stream_id, type, payload),
    subscribe: (from_seq, onEvent) => store.subscribeAll(from_seq, onEvent),
  };
}

test('host.stats reports system, active Vibecodium, and global session counts', async () => {
  const store = new EventStore({ filename: ':memory:' });
  const commands = new Map<string, RegisteredCommand>();
  store.append('session:active', 'session_started', {
    session_id: 'active',
    provider: 'fake',
    prompt: 'hello',
  });
  store.append('session:done', 'session_started', {
    session_id: 'done',
    provider: 'fake',
    prompt: 'goodbye',
  });
  store.append('session:done', 'session_complete', {
    session_id: 'done',
    provider: 'fake',
  });

  const host = createHostSubsystem({
    system: {
      totalmem: () => 1000,
      freemem: () => 250,
      loadavg: () => [1.25, 0.75, 0.5],
      uptime: () => 123,
    },
    machineList: async () => ({
      sessions: [
        {
          source: 'omp',
          ref: 'one',
          title: 'one',
          cwd: '/tmp/one',
          updated_at: new Date(0).toISOString(),
        },
        {
          source: 'codex',
          ref: 'two',
          title: 'two',
          cwd: '/tmp/two',
          updated_at: new Date(0).toISOString(),
        },
        {
          source: 'omp',
          ref: 'three',
          title: 'three',
          cwd: '/tmp/three',
          updated_at: new Date(0).toISOString(),
        },
      ],
    }),
  });
  host.register(contextFor(store, commands));

  assert.deepEqual(await commands.get(COMMAND_NAMES.hostStats)?.({}), {
    mem_total: 1000,
    mem_used: 750,
    load: [1.25, 0.75, 0.5],
    uptime_seconds: 123,
    vibecodium_sessions: 1,
    global_sessions: 3,
    max_concurrent: 3,
  });
  store.close();
});

test('host.set_session_cap persists and admission follows the cap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-host-'));
  const configPath = path.join(root, 'host-config.json');
  const previousConfigPath = process.env.VIBECODIUM_HOST_CONFIG_PATH;
  const previousEnvCap = process.env.VIBECODIUM_MAX_CONCURRENT_SESSIONS;
  process.env.VIBECODIUM_HOST_CONFIG_PATH = configPath;
  process.env.VIBECODIUM_MAX_CONCURRENT_SESSIONS = '2';
  const store = new EventStore({ filename: ':memory:' });
  const commands = new Map<string, RegisteredCommand>();
  try {
    const host = createHostSubsystem({ machineList: async () => ({ sessions: [] }) });
    host.register(contextFor(store, commands));
    assert.deepEqual(commands.get(COMMAND_NAMES.hostSetSessionCap)?.({ max_concurrent: 5 }), {
      max_concurrent: 5,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { max_concurrent: 5 });

    const budget = new AdmissionBudget({
      maxConcurrent: admissionConfigFromEnv().maxConcurrent,
      rateMax: 100,
      rateWindowMs: 1000,
    });
    assert.deepEqual(budget.tryAdmit(5), {
      ok: false,
      reason: 'concurrency',
      limit: 5,
    });

    fs.unlinkSync(configPath);
    assert.deepEqual(budget.tryAdmit(2), {
      ok: false,
      reason: 'concurrency',
      limit: 2,
    });
  } finally {
    store.close();
    if (previousConfigPath === undefined) delete process.env.VIBECODIUM_HOST_CONFIG_PATH;
    else process.env.VIBECODIUM_HOST_CONFIG_PATH = previousConfigPath;
    if (previousEnvCap === undefined) delete process.env.VIBECODIUM_MAX_CONCURRENT_SESSIONS;
    else process.env.VIBECODIUM_MAX_CONCURRENT_SESSIONS = previousEnvCap;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
