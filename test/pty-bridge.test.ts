import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import type { Subsystem, SubsystemContext } from '../src/contracts/subsystem.js';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateCreateOptions,
  SubstrateKey,
  SubstrateOutputListener,
  SubstrateSessionInfo,
} from '../src/contracts/substrate-contract.js';
import { ControlPlane } from '../src/server/control-plane.js';
import type { ControlPlaneAddress } from '../src/server/control-plane.js';
import { PtySubscriptionHub } from '../src/session/pty-subscriptions.js';

type WireMessage = {
  type: string;
  session_id?: string;
  data_b64?: string;
  code?: string;
};

class TestSubstrate implements SubstrateClient {
  public readonly outputListeners = new Set<SubstrateOutputListener>();
  public registrations = 0;
  public releases = 0;

  public async createSession(
    name: string,
    argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo> {
    void argv;
    void options;
    return { name, live: true };
  }

  public async attach(name: string): Promise<SubstrateAttachment> {
    return { name, detach: async () => undefined };
  }

  public async write(): Promise<void> {}

  public async sendKey(name: string, key: SubstrateKey): Promise<void> {
    void name;
    void key;
  }

  public onOutput(listener: SubstrateOutputListener): () => void {
    this.outputListeners.add(listener);
    this.registrations += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.outputListeners.delete(listener);
      this.releases += 1;
    };
  }

  public async isLive(): Promise<boolean> {
    return true;
  }

  public async kill(): Promise<void> {}

  public async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    return [];
  }

  public emit(name: string, data: Uint8Array): void {
    for (const listener of [...this.outputListeners]) listener({ name, data });
  }
}

class Inbox {
  private readonly messages: WireMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: WireMessage) => boolean;
    resolve: (message: WireMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  public constructor(socket: WebSocket) {
    socket.on('message', (data) => this.receive(JSON.parse(data.toString()) as WireMessage));
  }

  public wait(
    predicate: (message: WireMessage) => boolean,
    timeoutMs = 2_000,
  ): Promise<WireMessage> {
    const existing = this.messages.findIndex(predicate);
    if (existing >= 0) return Promise.resolve(this.messages.splice(existing, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for WebSocket message'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  public size(): number {
    return this.messages.length;
  }

  private receive(message: WireMessage): void {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) {
      this.messages.push(message);
      return;
    }
    const waiter = this.waiters.splice(index, 1)[0]!;
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sourceSubsystem(hub: PtySubscriptionHub): Subsystem {
  return {
    name: 'pty-test',
    register(context: SubsystemContext): void {
      context.registerPtySource?.(hub.subscribe.bind(hub));
    },
  };
}

function connect(address: ControlPlaneAddress): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address.wsUrl);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForCondition(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (++attempts > 1_000) {
        reject(new Error('condition did not become true'));
        return;
      }
      setImmediate(check);
    };
    check();
  });
}

function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

function waitForTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('replays buffered output, keeps the tail at 64KiB, and isolates sessions', () => {
  const substrate = new TestSubstrate();
  const names = new Map([
    ['first', 'substrate-first'],
    ['second', 'substrate-second'],
  ]);
  const hub = new PtySubscriptionHub(substrate, (sessionId) => names.get(sessionId));
  const first: Uint8Array[] = [];
  const second: Uint8Array[] = [];
  const unsubscribeFirst = hub.subscribe('first', (data) => first.push(data));
  const unsubscribeSecond = hub.subscribe('second', (data) => second.push(data));

  substrate.emit('substrate-first', bytes('first-output'));
  substrate.emit('substrate-second', bytes('second-output'));
  assert.equal(new TextDecoder().decode(first[0]), 'first-output');
  assert.equal(new TextDecoder().decode(second[0]), 'second-output');

  unsubscribeFirst();
  const replay: Uint8Array[] = [];
  const unsubscribeReplay = hub.subscribe('first', (data) => replay.push(data));
  assert.equal(new TextDecoder().decode(replay[0]), 'first-output');
  unsubscribeReplay();
  unsubscribeSecond();

  const capped = new PtySubscriptionHub(substrate, () => 'substrate-cap');
  const live = capped.subscribe('cap', () => undefined);
  cappedOutput(substrate, 'substrate-cap', 65_536, 65_536);
  substrate.emit('substrate-cap', bytes('TAIL'));
  live();
  const retained: Uint8Array[] = [];
  const replayRetained = capped.subscribe('cap', (data) => retained.push(data));
  const output = Buffer.concat(retained.map((data) => Buffer.from(data)));
  assert.ok(output.byteLength <= 65_536);
  assert.equal(output.subarray(-4).toString(), 'TAIL');
  assert.equal(output.byteLength, 65_536);
  replayRetained();
});

function cappedOutput(substrate: TestSubstrate, name: string, size: number, fill: number): void {
  substrate.emit(name, new Uint8Array(size).fill(fill % 256));
}

test('unsubscribes idempotently and releases the single substrate listener', () => {
  const substrate = new TestSubstrate();
  const hub = new PtySubscriptionHub(substrate, () => 'substrate');
  const unsubscribeOne = hub.subscribe('one', () => undefined);
  const unsubscribeTwo = hub.subscribe('two', () => undefined);
  assert.equal(substrate.registrations, 1);
  unsubscribeOne();
  unsubscribeOne();
  assert.equal(substrate.releases, 0);
  unsubscribeTwo();
  unsubscribeTwo();
  assert.equal(substrate.releases, 1);
  assert.equal(substrate.outputListeners.size, 0);
});

test('unknown session waits for its substrate name without throwing', () => {
  const substrate = new TestSubstrate();
  const name: { value?: string } = {};
  const received: Uint8Array[] = [];
  const hub = new PtySubscriptionHub(substrate, () => name.value);
  const unsubscribe = hub.subscribe('unknown', (data) => received.push(data));
  substrate.emit('substrate', bytes('ignored'));
  assert.equal(received.length, 0);
  name.value = 'substrate';
  substrate.emit('substrate', bytes('resolved'));
  assert.equal(new TextDecoder().decode(received[0]), 'resolved');
  unsubscribe();
});

test('routes PTY frames, never persists them, and cleans up on socket close', async () => {
  const substrate = new TestSubstrate();
  const names = new Map([['session-1', 'substrate-1']]);
  const hub = new PtySubscriptionHub(substrate, (sessionId) => names.get(sessionId));
  const controlPlane = new ControlPlane({
    dataPath: ':memory:',
    port: 0,
    subsystems: [sourceSubsystem(hub)],
  });
  let socket: WebSocket | undefined;
  try {
    const address = await controlPlane.start();
    socket = await connect(address);
    const inbox = new Inbox(socket);
    const before = controlPlane.eventStore.latestSequence();
    socket.send(JSON.stringify({ type: 'pty_subscribe', session_id: 'session-1' }));
    await waitForCondition(() => substrate.outputListeners.size === 1);
    substrate.emit('substrate-1', bytes('\u001b[2Jreal tui output\r\n'));
    const frame = await inbox.wait((message) => message.type === 'pty');
    assert.equal(frame.session_id, 'session-1');
    assert.equal(
      Buffer.from(frame.data_b64 ?? '', 'base64').toString(),
      '\u001b[2Jreal tui output\r\n',
    );
    assert.equal(controlPlane.eventStore.latestSequence(), before);
    assert.deepEqual(controlPlane.eventStore.readAll(before), []);

    socket.send(JSON.stringify({ type: 'pty_unsubscribe', session_id: 'session-1' }));
    await waitForCondition(() => substrate.outputListeners.size === 0);
    const pending = inbox.size();
    substrate.emit('substrate-1', bytes('after-unsubscribe'));
    await waitForTick();
    assert.equal(inbox.size(), pending);

    socket.send(JSON.stringify({ type: 'pty_subscribe', session_id: 'session-1' }));
    await waitForCondition(() => substrate.outputListeners.size === 1);
    assert.equal(substrate.outputListeners.size, 1);
    await close(socket);
    socket = undefined;
    await waitForCondition(() => substrate.outputListeners.size === 0);
  } finally {
    if (socket) await close(socket);
    await controlPlane.stop();
  }
});
