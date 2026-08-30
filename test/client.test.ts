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
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) listener({});
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
        if (url.endsWith('/commands/machine.list'))
          return {
            value: {
              sessions: [
                {
                  source: 'omp',
                  ref: 'session-ref',
                  title: 'Existing session',
                  cwd: '/tmp/repo',
                  updated_at: '2026-01-01T00:00:00.000Z',
                },
              ],
            },
          };
        if (url.endsWith('/commands/session.resume'))
          return { value: { session_id: 'session-2', stream_id: 'session:session-2' } };
        if (url.endsWith('/commands/workspace.status'))
          return { value: { branch: 'main', dirty: true, ahead: 1, behind: 0 } };
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
    const result = await client.openSession({
      provider: 'fake',
      prompt: 'hello',
      cwd: '/tmp/repo',
      project: 'repo',
    });
    assert.deepEqual(result, { session_id: 'session-1', stream_id: 'session:session-1' });
    assert.equal(requests[0]?.url, 'http://127.0.0.1:4310/commands/session.open');
    assert.equal(requests[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      provider: 'fake',
      prompt: 'hello',
      cwd: '/tmp/repo',
      project: 'repo',
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

    const machineResult = await client.machineList();
    assert.deepEqual(machineResult.sessions[0], {
      source: 'omp',
      ref: 'session-ref',
      title: 'Existing session',
      cwd: '/tmp/repo',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(requests[3]?.url, 'http://127.0.0.1:4310/commands/machine.list');
    assert.equal(requests[3]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[3]?.init?.body)), {});

    const resumed = await client.resumeSession({
      source: 'omp',
      ref: 'session-ref',
      prompt: 'continue',
      cwd: '/tmp/repo',
      project: 'repo',
    });
    assert.deepEqual(resumed, { session_id: 'session-2', stream_id: 'session:session-2' });
    assert.equal(requests[4]?.url, 'http://127.0.0.1:4310/commands/session.resume');
    assert.equal(requests[4]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[4]?.init?.body)), {
      source: 'omp',
      ref: 'session-ref',
      prompt: 'continue',
      cwd: '/tmp/repo',
      project: 'repo',
    });

    const workspaceStatus = await client.workspaceStatus({ path: '/tmp/repo' });
    assert.deepEqual(workspaceStatus, { branch: 'main', dirty: true, ahead: 1, behind: 0 });
    assert.equal(requests[5]?.url, 'http://127.0.0.1:4310/commands/workspace.status');
    assert.equal(requests[5]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[5]?.init?.body)), { path: '/tmp/repo' });
    const received: EventEnvelope[] = [];
    const unsubscribe = client.subscribe(0, (event) => received.push(event));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const socket = StubSocket.instances[0]!;
    socket.open();
    assert.deepEqual(JSON.parse(socket.sent[0]!), {
      type: 'subscribe',
      streamId: 'session:session-2',
      fromSeq: 0,
      token: 'token-1',
    });
    const event: EventEnvelope = {
      seq: 1,
      stream_id: 'session:session-2',
      type: 'session_started',
      payload: { session_id: 'session-2', provider: 'fake', prompt: 'hello' },
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
test('SDK frames project commands as POST requests', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    const url = String(input);
    const value = url.endsWith('/commands/project.list')
      ? { projects: [] }
      : url.endsWith('/commands/project.detect')
        ? { proposed: [{ id: 'test', label: 'Test', prompt: 'run tests' }] }
        : url.endsWith('/commands/project.save')
          ? {
              project: {
                name: 'repo',
                path: '/tmp/repo',
                description: 'A repo',
                quickActions: [{ id: 'test', label: 'Test', prompt: 'run tests' }],
                scope: 'project',
              },
            }
          : { removed: true };
    return { ok: true, status: 200, json: async () => ({ value }) } as Response;
  };
  try {
    const client = createClient({ baseUrl: 'http://127.0.0.1:4310' });
    assert.deepEqual(await client.listProjects(), { projects: [] });
    assert.deepEqual(await client.detectProject({ path: '/tmp/repo', description: 'A repo' }), {
      proposed: [{ id: 'test', label: 'Test', prompt: 'run tests' }],
    });
    const quickActions = [{ id: 'test', label: 'Test', prompt: 'run tests' }];
    assert.deepEqual(
      await client.saveProject({
        name: 'repo',
        path: '/tmp/repo',
        description: 'A repo',
        quickActions,
      }),
      {
        project: {
          name: 'repo',
          path: '/tmp/repo',
          description: 'A repo',
          quickActions,
          scope: 'project',
        },
      },
    );
    assert.deepEqual(await client.removeProject({ name: 'repo' }), { removed: true });
    assert.deepEqual(
      requests.map((request) => [
        request.url,
        request.init?.method,
        JSON.parse(String(request.init?.body)),
      ]),
      [
        ['http://127.0.0.1:4310/commands/project.list', 'POST', {}],
        [
          'http://127.0.0.1:4310/commands/project.detect',
          'POST',
          { path: '/tmp/repo', description: 'A repo' },
        ],
        [
          'http://127.0.0.1:4310/commands/project.save',
          'POST',
          { name: 'repo', path: '/tmp/repo', description: 'A repo', quickActions },
        ],
        ['http://127.0.0.1:4310/commands/project.remove', 'POST', { name: 'repo' }],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('SDK reconnects after a socket close and backfills from the next sequence', async () => {
  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  StubSocket.instances.length = 0;
  (globalThis as unknown as { WebSocket: typeof StubSocket }).WebSocket = StubSocket;
  try {
    const client = createClient({ baseUrl: 'http://127.0.0.1:4310/' });
    const received: EventEnvelope[] = [];
    const unsubscribe = client.subscribe(0, (event) => received.push(event), '*');
    const firstSocket = StubSocket.instances[0]!;
    firstSocket.open();
    const firstEvent: EventEnvelope = {
      seq: 7,
      stream_id: 'session:session-1',
      type: 'session_output',
      payload: { session_id: 'session-1', index: 0, text: 'first' },
      ts: '2026-01-01T00:00:00.000Z',
    };
    firstSocket.message({ type: 'event', event: firstEvent });
    firstSocket.close();
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 80));
    const secondSocket = StubSocket.instances[1]!;
    secondSocket.open();
    assert.deepEqual(JSON.parse(secondSocket.sent[0]!), {
      type: 'subscribe',
      streamId: '*',
      fromSeq: 8,
    });
    const secondEvent = {
      ...firstEvent,
      seq: 8,
      payload: { ...firstEvent.payload, text: 'second' },
    };
    secondSocket.message({ type: 'event', event: secondEvent });
    assert.deepEqual(received, [firstEvent, secondEvent]);
    unsubscribe();
  } finally {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  }
});

test('SDK subscribes to read-only PTY frames and unsubscribes cleanly', () => {
  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  StubSocket.instances.length = 0;
  (globalThis as unknown as { WebSocket: typeof StubSocket }).WebSocket = StubSocket;
  try {
    const client = createClient({ baseUrl: 'http://127.0.0.1:4310/', token: 'token-1' });
    const chunks: Uint8Array[] = [];
    const unsubscribe = client.subscribePty('session-1', {
      onData: (data) => chunks.push(data),
      onStatus: (status) => {
        if (status === 'error') throw new Error('unexpected PTY error');
      },
    });
    const socket = StubSocket.instances[0]!;
    socket.open();
    assert.deepEqual(JSON.parse(socket.sent[0]!), {
      type: 'pty_subscribe',
      session_id: 'session-1',
      token: 'token-1',
    });
    socket.message({
      type: 'pty',
      session_id: 'session-1',
      data_b64: Buffer.from('\u001b[2Jmirror').toString('base64'),
    });
    socket.message({
      type: 'pty',
      session_id: 'other',
      data_b64: Buffer.from('ignored').toString('base64'),
    });
    assert.equal(new TextDecoder().decode(chunks[0]), '\u001b[2Jmirror');
    unsubscribe();
    assert.deepEqual(JSON.parse(socket.sent[1]!), {
      type: 'pty_unsubscribe',
      session_id: 'session-1',
      token: 'token-1',
    });
    assert.equal(socket.readyState, 3);
  } finally {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  }
});

test('PTY frames decode to exact bytes, never through a lossy string round-trip', () => {
  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  StubSocket.instances.length = 0;
  (globalThis as unknown as { WebSocket: typeof StubSocket }).WebSocket = StubSocket;
  try {
    const client = createClient({ baseUrl: 'http://127.0.0.1:4310' });
    const chunks: Uint8Array[] = [];
    const dispose = client.subscribePty('session-1', { onData: (data) => chunks.push(data) });
    const socket = StubSocket.instances[0]!;
    socket.open();
    // A raw PTY carries ANSI escapes, UTF-8 multibyte, NUL, and bytes that are not valid UTF-8 at
    // all. All of them must reach xterm unchanged.
    const raw = Uint8Array.from([
      0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0xff, 0xfe, 0xc3, 0xa9, 0xf0, 0x9f, 0x94, 0xa5, 0x0d,
      0x0a,
    ]);
    socket.message({
      type: 'pty',
      session_id: 'session-1',
      data_b64: Buffer.from(raw).toString('base64'),
    });
    assert.equal(chunks.length, 1);
    assert.deepEqual([...chunks[0]!], [...raw]);
    // No token configured: the subscribe frame must omit it rather than send undefined.
    assert.deepEqual(JSON.parse(socket.sent[0]!), {
      type: 'pty_subscribe',
      session_id: 'session-1',
    });
    dispose();
  } finally {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  }
});

test('PTY subscription reports disconnect, resubscribes once, and stops after dispose', () => {
  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  const originalSetTimeout = globalThis.setTimeout;
  StubSocket.instances.length = 0;
  (globalThis as unknown as { WebSocket: typeof StubSocket }).WebSocket = StubSocket;
  // Drive the reconnect backoff deterministically instead of sleeping through it: capture the
  // scheduled callbacks and fire them on demand.
  const pending: Array<() => void> = [];
  globalThis.setTimeout = ((callback: () => void) => {
    pending.push(callback);
    return 0;
  }) as unknown as typeof globalThis.setTimeout;
  const flush = (): void => {
    const scheduled = pending.splice(0, pending.length);
    for (const callback of scheduled) callback();
  };
  try {
    const client = createClient({ baseUrl: 'https://phone.example/', token: 'token-2' });
    const statuses: string[] = [];
    const dispose = client.subscribePty('session-1', {
      onData: () => undefined,
      onStatus: (status) => statuses.push(status),
    });
    const first = StubSocket.instances[0]!;
    assert.equal(first.url, 'wss://phone.example/', 'https origin must upgrade to wss');
    first.open();
    // Reopening must not double-subscribe: the server would fan out two copies of every frame.
    first.open();
    assert.equal(first.sent.filter((frame) => frame.includes('pty_subscribe')).length, 1);

    first.close();
    flush();
    assert.equal(StubSocket.instances.length, 2, 'a dropped socket must reconnect');
    const second = StubSocket.instances[1]!;
    second.open();
    assert.deepEqual(JSON.parse(second.sent[0]!), {
      type: 'pty_subscribe',
      session_id: 'session-1',
      token: 'token-2',
    });
    assert.deepEqual(statuses, ['connecting', 'live', 'disconnected', 'connecting', 'live']);

    dispose();
    assert.deepEqual(JSON.parse(second.sent[1]!), {
      type: 'pty_unsubscribe',
      session_id: 'session-1',
      token: 'token-2',
    });
    assert.equal(second.readyState, 3);
    const sentAfterDispose = second.sent.length;
    // Disposing twice must not resend unsubscribe, and a later close must not reconnect.
    dispose();
    second.close();
    flush();
    assert.equal(second.sent.length, sentAfterDispose);
    assert.equal(StubSocket.instances.length, 2, 'dispose must cancel reconnection');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  }
});
