import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import type { ProviderChunk, ProviderSession } from '../src/contracts/provider-contract.js';
import {
  CodexProvider,
  EchoProvider,
  NotImplementedProvider,
  OmpProvider,
  ProviderNotImplementedError,
  mapProviderOutputEvent,
  providerByName,
} from '../src/provider/index.js';
import type { ChildProcessSpawner } from '../src/provider/index.js';

class MockChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  public complete(code = 0): void {
    this.exitCode = code;
    this.stdout.end();
    setImmediate(() => this.emit('close', code, null));
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.killed = true;
    this.signalCode = typeof signal === 'string' ? signal : null;
    this.emit('close', null, this.signalCode);
    return true;
  }
}

async function collect(
  provider: { stream: (session: ProviderSession) => AsyncIterable<ProviderChunk> },
  session: ProviderSession,
): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of provider.stream(session)) chunks.push(chunk);
  return chunks;
}

function mockSpawner(child: MockChild, calls: string[][]): ChildProcessSpawner {
  return (command, args) => {
    calls.push([command, ...args]);
    return child as unknown as ChildProcess;
  };
}

test('OMP maps mocked stdout chunks to ordered provider output', async () => {
  const child = new MockChild();
  const calls: string[][] = [];
  const provider = new OmpProvider({ spawn: mockSpawner(child, calls) });
  const session = await provider.spawn({ sessionId: 'omp-session', prompt: 'say hello' });
  const stream = collect(provider, session);

  child.stdout.write('first');
  child.stdout.write(' second');
  child.complete();

  assert.deepEqual(await stream, [
    { index: 0, text: 'first' },
    { index: 1, text: ' second' },
  ]);
  assert.deepEqual(calls[0], [
    'omp',
    '--print',
    '--mode',
    'text',
    '--no-session',
    '--',
    'say hello',
  ]);
});

test('Codex maps JSONL agent messages and ignores lifecycle frames', async () => {
  const child = new MockChild();
  const calls: string[][] = [];
  const provider = new CodexProvider({ spawn: mockSpawner(child, calls) });
  const session = await provider.spawn({ sessionId: 'codex-session', prompt: 'say hello' });
  const stream = collect(provider, session);
  const output =
    '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"hello"}}\n' +
    '{"type":"turn.completed"}\n';

  child.stdout.write(output.slice(0, 31));
  child.stdout.write(output.slice(31));
  child.complete();

  assert.deepEqual(await stream, [{ index: 0, text: 'hello' }]);
  assert.deepEqual(calls[0], ['codex', 'exec', '--json', '--ephemeral', '--', 'say hello']);
});

test('stop marks a CLI session and terminates its child', async () => {
  const child = new MockChild();
  const provider = new OmpProvider({ spawn: mockSpawner(child, []) });
  const session = await provider.spawn({ sessionId: 'stop-session', prompt: 'stop me' });

  await provider.stop(session);

  assert.equal(session.stopped, true);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
});

test('registry exposes real adapters, preserves echo, and leaves Claude unimplemented', async () => {
  assert.ok(providerByName('omp') instanceof OmpProvider);
  assert.ok(providerByName('codex') instanceof CodexProvider);
  assert.ok(providerByName('claude') instanceof NotImplementedProvider);

  const echo = providerByName('fake');
  assert.ok(echo instanceof EchoProvider);
  const echoSession = await echo.spawn({ sessionId: 'echo-session', prompt: 'hello world' });
  assert.deepEqual(await collect(echo, echoSession), [
    { index: 0, text: 'echo:hello' },
    { index: 1, text: 'echo:world' },
  ]);

  await assert.rejects(
    () => providerByName('claude').spawn({ sessionId: 'claude-session', prompt: 'hello' }),
    ProviderNotImplementedError,
  );
});

test('provider output mapper creates the frozen session_output payload', () => {
  assert.deepEqual(
    mapProviderOutputEvent({
      session_id: 'session-1',
      chunk: { index: 2, text: 'hello' },
    }),
    {
      type: 'session_output',
      payload: { session_id: 'session-1', index: 2, text: 'hello' },
    },
  );
});
