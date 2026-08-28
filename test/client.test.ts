import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '../src/client/index.js';
import type { EventEnvelope } from '../src/contracts/events.js';

type Listener = (event: unknown) => void;

class StubSocket {
  public static readonly instances: StubSocket[] = [];
  public readyState = 0;
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  public constructor(public readonly url: string) {
    StubSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
  }

  public open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get('open') ?? []) listener({});
  }

  public message(value: unknown): void {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data: JSON.stringify(value) });
  }
}

test('SDK posts command args and subscribes with the active stream frame', async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return {
      ok: true,
      status: 200,
      json: async () => {
        const url = String(input);
        if (url.endsWith('/commands/session.send'))
          return { value: { stream_id: 'session:session-1', turn: 2 } };
        if (url.endsWith('/commands/workspace.list'))
          return { value: { workspaces: [{ name: 'repo', path: '/tmp/repo' }] } };
        return { value: { session_id: 'session-1', stream_id: 'session:session-1' } };
      },
    } as Response;
  };
  (globalThis as unknown as { WebSocket: typeof StubSocket }).WebSocket = StubSocket;
  StubSocket.instances.length = 0;
  try {
    const client = createClient({ baseUrl: 'http://127.0.0.1:4310/', token: 'token-1' });
    const result = await client.openSession({ provider: 'fake', prompt: 'hello' });
    assert.deepEqual(result, { session_id: 'session-1', stream_id: 'session:session-1' });
    assert.equal(requests[0]?.url, 'http://127.0.0.1:4310/commands/session.open');
    assert.equal(requests[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      provider: 'fake',
      prompt: 'hello',
    });
    const sendResult = await client.sendMessage({
      session_id: 'session-1',
      prompt: 'follow up',
    });
    assert.deepEqual(sendResult, { stream_id: 'session:session-1', turn: 2 });
    assert.equal(requests[1]?.url, 'http://127.0.0.1:4310/commands/session.send');
    assert.equal(requests[1]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      session_id: 'session-1',
      prompt: 'follow up',
    });

    const workspaceResult = await client.listWorkspaces();
    assert.deepEqual(workspaceResult, {
      workspaces: [{ name: 'repo', path: '/tmp/repo' }],
    });
    assert.equal(requests[2]?.url, 'http://127.0.0.1:4310/commands/workspace.list');
    assert.equal(requests[2]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {});
    const received: EventEnvelope[] = [];
    const unsubscribe = client.subscribe(0, (event) => received.push(event));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const socket = StubSocket.instances[0]!;
    socket.open();
    assert.deepEqual(JSON.parse(socket.sent[0]!), {
      type: 'subscribe',
      streamId: 'session:session-1',
      fromSeq: 0,
      token: 'token-1',
    });
    const event: EventEnvelope = {
      seq: 1,
      stream_id: 'session:session-1',
      type: 'session_started',
      payload: { session_id: 'session-1', provider: 'fake', prompt: 'hello' },
      ts: '2026-01-01T00:00:00.000Z',
    };
    socket.message({ type: 'event', event });
    assert.deepEqual(received, [event]);
    unsubscribe();
    assert.equal(socket.readyState, 3);

    const wildcardUnsubscribe = client.subscribe(0, () => undefined, '*');
    const wildcardSocket = StubSocket.instances[1]!;
    wildcardSocket.open();
    assert.equal(JSON.parse(wildcardSocket.sent[0]!).streamId, '*');
    wildcardUnsubscribe();

    const explicitUnsubscribe = client.subscribe(0, () => undefined, 'session:x');
    const explicitSocket = StubSocket.instances[2]!;
    explicitSocket.open();
    assert.equal(JSON.parse(explicitSocket.sent[0]!).streamId, 'session:x');
    explicitUnsubscribe();

    const fallbackClient = createClient({ baseUrl: 'http://127.0.0.1:4310/' });
    const fallbackUnsubscribe = fallbackClient.subscribe(0, () => undefined);
    const fallbackSocket = StubSocket.instances[3]!;
    fallbackSocket.open();
    assert.equal(JSON.parse(fallbackSocket.sent[0]!).streamId, '*');
    fallbackUnsubscribe();
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  }
});
