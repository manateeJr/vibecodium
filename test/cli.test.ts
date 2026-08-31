import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { createClient, type VibecodiumClient } from '../src/client/index.js';
import { main, type AttachSpawner } from '../src/cli.js';
import { filterProjectChoices } from '../src/cli-list.js';

type Request = { readonly name: string; readonly args: unknown };
type SpawnCall = {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdio: unknown;
};

test('attach with no session lists sessions and their states', async () => {
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  const originalExitCode = process.exitCode;
  globalThis.fetch = async (input, init) => {
    requests.push({
      name: commandName(String(input)),
      args: JSON.parse(String(init?.body ?? '{}')) as unknown,
    });
    return response({
      sessions: [
        {
          session_id: 'session-live',
          stream_id: 'session:session-live',
          provider: 'omp',
          status: 'live',
        },
        {
          session_id: 'session-resumable',
          stream_id: 'session:session-resumable',
          provider: 'omp',
          status: 'resumable',
        },
      ],
    });
  };
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await main(['attach'], {
      client: client(),
      spawn: neverSpawn,
    });
    assert.deepEqual(requests, [{ name: 'session.list', args: {} }]);
    assert.equal(output, 'session-live\tlive\nsession-resumable\tresumable\n');
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
    globalThis.fetch = originalFetch;
  }
});

test('attach resumes a resumable session before spawning abduco', async () => {
  const operations: string[] = [];
  const calls: SpawnCall[] = [];
  const originalFetch = globalThis.fetch;
  const client = transportedClient(operations, (name) => {
    if (name === 'session.attach_info') {
      return {
        substrate_name: 'substrate-resumable',
        abduco_bin_path: '/custom/bin/abduco',
        state: 'resumable',
      };
    }
    if (name === 'session.ensure_live') {
      return { state: 'live', substrate_name: 'substrate-resumable' };
    }
    throw new Error(`unexpected command: ${name}`);
  });
  const originalExitCode = process.exitCode;
  try {
    await main(['attach', 'session-resumable'], {
      client,
      spawn: spawnSpy(operations, calls),
    });
    assert.deepEqual(operations, ['session.attach_info', 'session.ensure_live', 'spawn']);
    assert.deepEqual(calls, [
      {
        command: '/custom/bin/abduco',
        args: ['-a', 'substrate-resumable'],
        stdio: 'inherit',
      },
    ]);
  } finally {
    process.exitCode = originalExitCode;
    globalThis.fetch = originalFetch;
  }
});

test('attach ensures a live record is actually alive before spawning abduco', async () => {
  const operations: string[] = [];
  const calls: SpawnCall[] = [];
  const originalFetch = globalThis.fetch;
  const client = transportedClient(operations, (name) => {
    if (name === 'session.attach_info') {
      return {
        substrate_name: 'substrate-live',
        abduco_bin_path: '/tmp/vibecodium-abduco',
        state: 'live',
      };
    }
    if (name === 'session.ensure_live') return { state: 'live', substrate_name: 'substrate-live' };
    throw new Error(`unexpected command: ${name}`);
  });
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  const originalExitCode = process.exitCode;
  try {
    await main(['attach', 'session-live'], {
      client,
      spawn: spawnSpy(operations, calls),
    });
    assert.deepEqual(operations, ['session.attach_info', 'session.ensure_live', 'spawn']);
    assert.deepEqual(calls[0], {
      command: '/tmp/vibecodium-abduco',
      args: ['-a', 'substrate-live'],
      stdio: 'inherit',
    });
    assert.equal(output, 'detach: Ctrl+\\; double Ctrl+C exits the agent\n');
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
    globalThis.fetch = originalFetch;
  }
});

test('open creates an omp session for the requested path and attaches it', async () => {
  const operations: string[] = [];
  const requests: Request[] = [];
  const calls: SpawnCall[] = [];
  const originalFetch = globalThis.fetch;
  const client = transportedClient(operations, (name, args) => {
    requests.push({ name, args });
    if (name === 'session.open') {
      return { session_id: 'session-opened', stream_id: 'session:session-opened' };
    }
    if (name === 'session.attach_info') {
      return {
        substrate_name: 'substrate-opened',
        abduco_bin_path: '/opt/vibecodium/bin/abduco',
        state: 'live',
      };
    }
    if (name === 'session.ensure_live')
      return { state: 'live', substrate_name: 'substrate-opened' };
    throw new Error(`unexpected command: ${name}`);
  });
  const originalExitCode = process.exitCode;
  try {
    await main(['open', '/work/project'], {
      client,
      spawn: spawnSpy(operations, calls),
    });
    assert.deepEqual(operations, [
      'session.open',
      'session.attach_info',
      'session.ensure_live',
      'spawn',
    ]);
    assert.deepEqual(requests[0], {
      name: 'session.open',
      args: {
        provider: 'omp',
        prompt: '',
        cwd: '/work/project',
        origin: 'operator',
        source: 'cli',
      },
    });
    assert.deepEqual(calls[0], {
      command: '/opt/vibecodium/bin/abduco',
      args: ['-a', 'substrate-opened'],
      stdio: 'inherit',
    });
  } finally {
    process.exitCode = originalExitCode;
    globalThis.fetch = originalFetch;
  }
});
test('list defaults to operator sessions and emits JSON shape', async () => {
  const sessions = listFixtures();
  const result = await runListForTest(['--json'], sessions);
  assert.deepEqual((JSON.parse(result.output) as { sessions: unknown[] }).sessions, [sessions[0]]);
  assert.deepEqual(result.requestArgs, { limit: 1_000 });
});

test('list --all includes agent sessions', async () => {
  const sessions = listFixtures();
  const result = await runListForTest(['--all', '--json'], sessions);
  assert.deepEqual((JSON.parse(result.output) as { sessions: unknown[] }).sessions, sessions);
});

test('list --project passes and applies the project filter', async () => {
  const sessions = listFixtures();
  const result = await runListForTest(['--project', 'beta', '--all', '--json'], sessions);
  assert.deepEqual((JSON.parse(result.output) as { sessions: unknown[] }).sessions, [sessions[1]]);
  assert.deepEqual(result.requestArgs, { limit: 1_000, project: 'beta' });
});

test('project picker filters choices by case-insensitive name', () => {
  const projects = [{ name: 'Alpha' }, { name: 'Beta Tools' }, { name: 'Gamma' }] as const;
  assert.deepEqual(filterProjectChoices(projects, '  beta '), [projects[1]]);
  assert.deepEqual(filterProjectChoices(projects, ''), projects);
});

test('list --query matches session metadata and renders attach hints', async () => {
  const sessions = listFixtures();
  const result = await runListForTest(['--query', 'needle'], sessions);
  assert.match(result.output, /Operator label/);
  assert.match(result.output, /vibecodium attach operator-1/);
  assert.doesNotMatch(result.output, /Agent label/);
});

function listFixtures() {
  return [
    {
      session_id: 'operator-1',
      stream_id: 'session:operator-1',
      provider: 'omp',
      label: 'Operator label',
      origin: 'operator',
      project: 'alpha',
      status: 'live',
      prompt: 'needle prompt',
      updated_at: '2026-08-30T12:00:00.000Z',
    },
    {
      session_id: 'agent-1',
      stream_id: 'session:agent-1',
      provider: 'omp',
      label: 'Agent label',
      origin: 'agent',
      project: 'beta',
      status: 'done',
      updated_at: '2026-08-30T11:00:00.000Z',
    },
  ] as const;
}

async function runListForTest(
  args: string[],
  sessions: readonly unknown[],
): Promise<{ readonly output: string; readonly requestArgs: unknown }> {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  let output = '';
  let requestArgs: unknown;
  globalThis.fetch = async (input, init) => {
    assert.equal(commandName(String(input)), 'session.list');
    requestArgs = JSON.parse(String(init?.body ?? '{}')) as unknown;
    return response({ sessions });
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await main(['list', ...args], { client: client(), spawn: neverSpawn });
    return { output, requestArgs };
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
    globalThis.fetch = originalFetch;
  }
}

function client(): VibecodiumClient {
  return createClient({ baseUrl: 'http://127.0.0.1:4310' });
}

function transportedClient(
  operations: string[],
  valueFor: (name: string, args: unknown) => unknown,
): VibecodiumClient {
  globalThis.fetch = async (input, init) => {
    const name = commandName(String(input));
    operations.push(name);
    return response(valueFor(name, JSON.parse(String(init?.body ?? '{}')) as unknown));
  };
  return client();
}

function spawnSpy(operations: string[], calls: SpawnCall[]): AttachSpawner {
  return (command, args, options) => {
    operations.push('spawn');
    calls.push({ command, args: [...args], stdio: options.stdio });
    return {
      pid: 123,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    } as SpawnSyncReturns<Buffer>;
  };
}

const neverSpawn: AttachSpawner = () => {
  throw new Error('spawn should not be called');
};

function commandName(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

function response(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ value }),
  } as Response;
}
