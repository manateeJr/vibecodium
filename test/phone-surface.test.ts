import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The phone surface is untyped browser JS that the control plane serves verbatim from web/. It is
// outside tsconfig's emit, so a static import would resolve to dist/web/... at runtime and fail;
// these dynamic imports load the real shipped files by URL relative to this compiled test.
const webRoot = new URL('../../web/', import.meta.url);

type WorkState = {
  readonly lastUserSeq: number;
  readonly lastReplySeq: number;
  readonly working: boolean;
};
type SessionEvent = { readonly type: string; readonly seq: number };
type SessionStateModule = {
  readonly IDLE_WORK_STATE: WorkState;
  readonly applyWorkEvent: (state: WorkState, event: SessionEvent) => WorkState;
};

async function loadSessionState(): Promise<SessionStateModule> {
  return (await import(new URL('lib/session-state.js', webRoot).href)) as SessionStateModule;
}

/** Folds a whole event list, the way a hydrating transcript replays a stream. */
function derive(module: SessionStateModule, events: readonly SessionEvent[]): WorkState {
  return events.reduce(
    (state, event) => module.applyWorkEvent(state, event),
    module.IDLE_WORK_STATE,
  );
}

test('working state is a user input with no assistant reply after it', async () => {
  const sessionState = await loadSessionState();

  assert.equal(sessionState.IDLE_WORK_STATE.working, false, 'a fresh session is not working');

  assert.equal(
    derive(sessionState, [{ type: 'session_started', seq: 1 }]).working,
    true,
    'the opening prompt starts a turn',
  );
  assert.equal(
    derive(sessionState, [
      { type: 'session_started', seq: 1 },
      { type: 'session_output', seq: 2 },
    ]).working,
    false,
    'assistant output after the input ends the working state',
  );
  assert.equal(
    derive(sessionState, [
      { type: 'session_started', seq: 1 },
      { type: 'session_output', seq: 2 },
      { type: 'session_input', seq: 3 },
    ]).working,
    true,
    'a later input starts working again',
  );
  assert.equal(
    derive(sessionState, [
      { type: 'session_input', seq: 3 },
      { type: 'turn_complete', seq: 4 },
    ]).working,
    false,
    'turn_complete counts as the reply',
  );
  assert.equal(
    derive(sessionState, [
      { type: 'session_input', seq: 3 },
      { type: 'notify_emitted', seq: 4 },
      { type: 'inbound_received', seq: 5 },
    ]).working,
    true,
    'unrelated events must not clear the working state',
  );
  assert.equal(
    derive(sessionState, [
      { type: 'session_input', seq: 3 },
      { type: 'session_complete', seq: 9 },
    ]).working,
    false,
    'a finished session is never working',
  );
  assert.equal(
    derive(sessionState, [
      { type: 'session_input', seq: 3 },
      { type: 'verify_failed', seq: 9 },
    ]).working,
    false,
    'a failed session is never working',
  );
});

test('work state folding is pure and order-tolerant', async () => {
  const sessionState = await loadSessionState();
  const input: SessionEvent = { type: 'session_input', seq: 5 };
  const before = sessionState.applyWorkEvent(sessionState.IDLE_WORK_STATE, input);
  assert.deepEqual(sessionState.IDLE_WORK_STATE, {
    lastUserSeq: -1,
    lastReplySeq: -1,
    working: false,
  });
  // An out-of-order replay of an older reply must not resurrect a stale "not working".
  const afterStaleReply = sessionState.applyWorkEvent(before, { type: 'session_output', seq: 2 });
  assert.equal(afterStaleReply.working, true);
  const unrelated = sessionState.applyWorkEvent(before, { type: 'merge_to_main', seq: 6 });
  assert.equal(unrelated, before, 'an irrelevant event returns the same state object');
});

test('the vendored xterm bundle is intact and exposes Terminal on the global object', () => {
  const bundlePath = new URL('vendor/xterm/xterm.js', webRoot);
  const source = fs.readFileSync(bundlePath, 'utf8');
  const sandbox = createBrowserSandbox();
  vm.runInContext(source, vm.createContext(sandbox), { filename: 'xterm.js' });

  // The UMD bundle copies its exports onto the global, so the constructor IS globalThis.Terminal.
  // web/ui/pty-mirror.js depends on exactly this shape; a namespace would make it silently
  // unavailable forever.
  const Terminal = sandbox.Terminal as unknown;
  assert.equal(typeof Terminal, 'function', 'globalThis.Terminal must be the constructor');
  assert.equal(
    typeof (Terminal as { Terminal?: unknown }).Terminal,
    'undefined',
    'globalThis.Terminal.Terminal must not exist',
  );

  const terminal = new (
    Terminal as new (options: unknown) => {
      cols: number;
      write: (data: Uint8Array) => void;
      dispose: () => void;
    }
  )({ cols: 80, rows: 30, disableStdin: true, convertEol: false });
  assert.equal(terminal.cols, 80);
  // Raw bytes, not a string: this is what the mirror hands xterm for every PTY frame.
  terminal.write(Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xc3, 0xa9]));
  terminal.dispose();

  const licence = fs.readFileSync(new URL('vendor/xterm/LICENSE', webRoot), 'utf8');
  assert.match(licence, /MERCHANTABILITY/, 'the MIT licence text must ship with the bundle');
  assert.match(licence, /The xterm\.js authors/);
  const provenance = fs.readFileSync(new URL('vendor/xterm/README.md', webRoot), 'utf8');
  assert.match(provenance, /5\.3\.0/, 'provenance must pin the vendored version');
  assert.match(provenance, /never an npm dependency/i);
});

type StubListener = (event: unknown) => void;

/** Stands in for the browser WebSocket so the real pty-socket transport can be driven directly. */
class StubSocket {
  public static readonly instances: StubSocket[] = [];
  public readyState = 0;
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, StubListener[]>();

  public constructor(public readonly url: string) {
    StubSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: StubListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  public close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', {});
  }

  public message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) });
  }

  public subscribeFrames(): string[] {
    return this.sent.filter((frame) => frame.includes('pty_subscribe'));
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type PtySocketModule = {
  readonly createPtySubscription: (options: {
    baseUrl: string;
    token?: string;
    sessionId: string;
    onData: (data: Uint8Array) => void;
    onStatus?: (status: string, detail?: string) => void;
    webSocket?: unknown;
  }) => () => void;
};

test('pty subscription is token-scoped, byte-exact, idempotent, and reconnects', async () => {
  const ptySocket = (await import(new URL('lib/pty-socket.js', webRoot).href)) as PtySocketModule;
  StubSocket.instances.length = 0;
  const originalSetTimeout = globalThis.setTimeout;
  // Drive the reconnect backoff deterministically instead of sleeping through it.
  const pending: Array<() => void> = [];
  globalThis.setTimeout = ((callback: () => void) => {
    pending.push(callback);
    return 0;
  }) as unknown as typeof globalThis.setTimeout;
  const flush = (): void => {
    for (const callback of pending.splice(0, pending.length)) callback();
  };
  try {
    const chunks: Uint8Array[] = [];
    const statuses: string[] = [];
    const dispose = ptySocket.createPtySubscription({
      baseUrl: 'https://phone.example',
      token: 'token-1',
      sessionId: 'session-1',
      onData: (data) => chunks.push(data),
      onStatus: (status) => statuses.push(status),
      webSocket: StubSocket,
    });
    const first = StubSocket.instances[0]!;
    assert.equal(first.url, 'wss://phone.example', 'https origin must upgrade to wss');
    first.open();
    // Reopening must not double-subscribe: the server would fan out every frame twice.
    first.open();
    assert.equal(first.subscribeFrames().length, 1);
    assert.deepEqual(JSON.parse(first.sent[0]!), {
      type: 'pty_subscribe',
      session_id: 'session-1',
      token: 'token-1',
    });

    // A raw PTY carries ANSI escapes, UTF-8 multibyte, NUL, and bytes that are not valid UTF-8.
    const raw = Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0xff, 0xc3, 0xa9, 0x0d, 0x0a]);
    first.message({
      type: 'pty',
      session_id: 'session-1',
      data_b64: Buffer.from(raw).toString('base64'),
    });
    first.message({ type: 'pty', session_id: 'other', data_b64: 'aWdub3JlZA==' });
    assert.equal(chunks.length, 1, 'frames for another session are ignored');
    assert.deepEqual([...chunks[0]!], [...raw], 'bytes must survive the base64 hop exactly');

    first.close();
    flush();
    assert.equal(StubSocket.instances.length, 2, 'a dropped socket must reconnect');
    const second = StubSocket.instances[1]!;
    second.open();
    assert.equal(second.subscribeFrames().length, 1, 'the reconnect resubscribes');
    assert.deepEqual(statuses, ['connecting', 'live', 'disconnected', 'connecting', 'live']);

    dispose();
    assert.deepEqual(JSON.parse(second.sent[1]!), {
      type: 'pty_unsubscribe',
      session_id: 'session-1',
      token: 'token-1',
    });
    assert.equal(second.readyState, 3, 'dispose closes the socket');
    const sentAfterDispose = second.sent.length;
    dispose();
    second.close();
    flush();
    assert.equal(second.sent.length, sentAfterDispose, 'disposing twice sends nothing more');
    assert.equal(StubSocket.instances.length, 2, 'dispose cancels reconnection');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('a loopback subscription omits the token instead of sending undefined', async () => {
  const ptySocket = (await import(new URL('lib/pty-socket.js', webRoot).href)) as PtySocketModule;
  StubSocket.instances.length = 0;
  const dispose = ptySocket.createPtySubscription({
    baseUrl: 'http://127.0.0.1:4310',
    sessionId: 'session-1',
    onData: () => undefined,
    webSocket: StubSocket,
  });
  const socket = StubSocket.instances[0]!;
  assert.equal(socket.url, 'ws://127.0.0.1:4310', 'http origin must downgrade to ws');
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    type: 'pty_subscribe',
    session_id: 'session-1',
  });
  dispose();
});

type MirrorModule = {
  readonly createPtyMirror: (options: unknown) => {
    selectSession: (id: string) => void;
    setVisible: (visible: boolean) => void;
  };
};

test('the pty mirror subscribes when shown and tears down when hidden or switched', async () => {
  const mirror = (await import(new URL('ui/pty-mirror.js', webRoot).href)) as MirrorModule;
  StubSocket.instances.length = 0;
  const writes: Uint8Array[] = [];
  let disposedTerminals = 0;
  const status = { textContent: '' };
  const empty = { hidden: false, textContent: '' };
  const terminalTarget = {
    hidden: false,
    setAttribute: () => undefined,
    replaceChildren: () => undefined,
  };
  const previousTerminal = (globalThis as { Terminal?: unknown }).Terminal;
  const previousComputedStyle = globalThis.getComputedStyle;
  (globalThis as { Terminal?: unknown }).Terminal = class {
    public write(data: Uint8Array): void {
      writes.push(data);
    }
    public open(): void {}
    public attachCustomKeyEventHandler(): void {}
    public dispose(): void {
      disposedTerminals += 1;
    }
  };
  // The mirror reads design tokens for its theme; outside a browser there is no computed style.
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = undefined;
  try {
    const instance = mirror.createPtyMirror({
      connection: () => ({
        baseUrl: 'http://127.0.0.1:4310',
        token: 'token-1',
        webSocket: StubSocket,
      }),
      terminalTarget,
      empty,
      status,
    });

    instance.selectSession('session-1');
    assert.equal(StubSocket.instances.length, 0, 'a hidden mirror must not open a socket');
    assert.equal(status.textContent, 'READY');

    instance.setVisible(true);
    assert.equal(StubSocket.instances.length, 1);
    const first = StubSocket.instances[0]!;
    first.open();
    assert.equal(status.textContent, 'LIVE · READ ONLY');
    first.message({ type: 'pty', session_id: 'session-1', data_b64: 'QQ==' });
    assert.deepEqual([...writes[0]!], [0x41], 'replayed bytes reach the terminal');

    // Rapid toggling must not leave a second socket or terminal behind.
    instance.setVisible(true);
    assert.equal(StubSocket.instances.length, 2);
    assert.equal(first.readyState, 3, 'the previous socket is closed');
    assert.equal(disposedTerminals, 1, 'the previous terminal is disposed');

    instance.selectSession('session-2');
    assert.equal(StubSocket.instances.length, 3);
    assert.equal(StubSocket.instances[1]!.readyState, 3, 'switching sessions unsubscribes');
    StubSocket.instances[2]!.open();
    assert.deepEqual(JSON.parse(StubSocket.instances[2]!.sent[0]!), {
      type: 'pty_subscribe',
      session_id: 'session-2',
      token: 'token-1',
    });

    instance.setVisible(false);
    assert.equal(StubSocket.instances[2]!.readyState, 3, 'hiding unsubscribes');
    assert.equal(disposedTerminals, 3, 'hiding disposes the terminal');
    assert.equal(status.textContent, 'PAUSED');

    instance.selectSession('');
    assert.equal(status.textContent, 'NO SESSION');
    assert.equal(StubSocket.instances.length, 3, 'no session means no socket');
  } finally {
    (globalThis as { Terminal?: unknown }).Terminal = previousTerminal;
    (globalThis as { getComputedStyle?: unknown }).getComputedStyle = previousComputedStyle;
  }
});

test('the pty mirror reports unavailable instead of throwing when xterm is missing', async () => {
  const mirror = (await import(new URL('ui/pty-mirror.js', webRoot).href)) as MirrorModule;
  StubSocket.instances.length = 0;
  const status = { textContent: '' };
  const empty = { hidden: true, textContent: '' };
  const previousTerminal = (globalThis as { Terminal?: unknown }).Terminal;
  (globalThis as { Terminal?: unknown }).Terminal = undefined;
  try {
    const instance = mirror.createPtyMirror({
      connection: () => ({ baseUrl: 'http://127.0.0.1:4310', webSocket: StubSocket }),
      terminalTarget: {
        hidden: false,
        setAttribute: () => undefined,
        replaceChildren: () => undefined,
      },
      empty,
      status,
    });
    instance.selectSession('session-1');
    instance.setVisible(true);
    assert.equal(status.textContent, 'UNAVAILABLE');
    assert.equal(empty.hidden, false);
    assert.equal(StubSocket.instances.length, 0, 'no terminal means no socket');
  } finally {
    (globalThis as { Terminal?: unknown }).Terminal = previousTerminal;
  }
});

/** Enough of a DOM for xterm.js to initialise headlessly. */
function createBrowserSandbox(): Record<string, unknown> {
  const context2d = {
    measureText: () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    fillText: () => undefined,
    fillRect: () => undefined,
    clearRect: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    scale: () => undefined,
    setTransform: () => undefined,
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    fill: () => undefined,
  };
  const createElement = (): Record<string, unknown> => ({
    style: {},
    dataset: {},
    classList: {
      add: () => undefined,
      remove: () => undefined,
      contains: () => false,
      toggle: () => undefined,
    },
    setAttribute: () => undefined,
    getAttribute: () => null,
    removeAttribute: () => undefined,
    appendChild: (child: unknown) => child,
    append: () => undefined,
    remove: () => undefined,
    replaceChildren: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0 }),
    getContext: () => context2d,
    focus: () => undefined,
    querySelector: () => null,
  });
  const sandbox: Record<string, unknown> = {
    navigator: { userAgent: 'node', platform: 'linux', language: 'en', clipboard: {} },
    document: {
      createElement,
      createDocumentFragment: createElement,
      createTextNode: createElement,
      documentElement: createElement(),
      body: createElement(),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      querySelector: () => null,
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    Path2D: class {},
    OffscreenCanvas: class {
      public getContext(): unknown {
        return context2d;
      }
    },
    ResizeObserver: class {
      public observe(): void {}
      public disconnect(): void {}
    },
    IntersectionObserver: class {
      public observe(): void {}
      public disconnect(): void {}
    },
    MutationObserver: class {
      public observe(): void {}
      public disconnect(): void {}
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  return sandbox;
}
