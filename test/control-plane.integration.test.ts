import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { Authority } from '../src/server/authority.js';
import { ControlPlane } from '../src/server/control-plane.js';
import type { ControlPlaneAddress } from '../src/server/control-plane.js';
import type { StoredEvent } from '../src/server/event-store.js';

type WireMessage = {
  type: string;
  event?: StoredEvent;
  streamId?: string;
  sessionId?: string;
  cursor?: number;
  allowed?: boolean;
  reason?: string;
  requestId?: string;
};

class Inbox {
  private readonly messages: WireMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: WireMessage) => boolean;
    resolve: (message: WireMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  public constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.receive(JSON.parse(data.toString()) as WireMessage));
  }

  public wait(
    predicate: (message: WireMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<WireMessage> {
    const existingIndex = this.messages.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(this.messages.splice(existingIndex, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for WebSocket message'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  private receive(message: WireMessage): void {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex < 0) {
      this.messages.push(message);
      return;
    }
    const waiter = this.waiters.splice(waiterIndex, 1)[0]!;
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }
}

function connect(address: ControlPlaneAddress): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address.wsUrl);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 5_000) throw new Error('timed out waiting for session completion');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test('opens an echo session, streams ordered events, and catches up after reconnect', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-control-plane-'));
  const controlPlane = new ControlPlane({
    dataPath: path.join(directory, 'events.sqlite'),
    port: 0,
    authority: new Authority({
      permitted: [
        { type: 'session.open', scope: { provider: 'fake' } },
        { type: 'session.stop', scope: { session_id: '*' } },
      ],
    }),
  });
  let firstSocket: WebSocket | undefined;
  let secondSocket: WebSocket | undefined;
  try {
    const address = await controlPlane.start();
    assert.equal(address.host, '127.0.0.1');
    firstSocket = await connect(address);
    const firstInbox = new Inbox(firstSocket);
    firstSocket.send(
      JSON.stringify({ type: 'session.open', provider: 'fake', prompt: 'hello world' }),
    );
    const opened = await firstInbox.wait((message) => message.type === 'session.opened');
    assert.ok(opened.streamId);
    assert.ok(opened.sessionId);
    firstSocket.send(JSON.stringify({ type: 'subscribe', streamId: opened.streamId, fromSeq: 0 }));
    await firstInbox.wait((message) => message.type === 'subscribed');

    const receivedBeforeDisconnect: StoredEvent[] = [];
    let firstOutput: StoredEvent | undefined;
    while (!firstOutput) {
      const message = await firstInbox.wait(
        (candidate) => candidate.type === 'event' && !!candidate.event,
      );
      receivedBeforeDisconnect.push(message.event!);
      if (message.event!.type === 'provider.output') firstOutput = message.event;
    }
    assert.ok(firstOutput);
    assert.deepEqual(
      receivedBeforeDisconnect.map((event) => event.seq),
      [1, 2, 3],
    );
    const cursor = firstOutput.seq;
    await close(firstSocket);

    await waitUntil(() =>
      controlPlane.eventStore
        .read(opened.streamId!, cursor)
        .some((event) => event.type === 'session.completed'),
    );
    const expectedMissed = controlPlane.eventStore.read(opened.streamId!, cursor);

    secondSocket = await connect(address);
    const secondInbox = new Inbox(secondSocket);
    secondSocket.send(
      JSON.stringify({ type: 'subscribe', streamId: opened.streamId, fromSeq: cursor }),
    );
    await secondInbox.wait((message) => message.type === 'subscribed');
    const replayed: StoredEvent[] = [];
    while (!replayed.some((event) => event.type === 'session.completed')) {
      const message = await secondInbox.wait(
        (candidate) => candidate.type === 'event' && !!candidate.event,
      );
      replayed.push(message.event!);
    }
    assert.deepEqual(replayed, expectedMissed);

    secondSocket.send(
      JSON.stringify({
        type: 'action.request',
        requestId: 'deny-write',
        action: { type: 'filesystem.write', scope: { path: '/tmp/example' } },
      }),
    );
    assert.deepEqual(
      await secondInbox.wait(
        (message) => message.type === 'action.result' && message.reason === 'unpermitted',
      ),
      { type: 'action.result', allowed: false, reason: 'unpermitted', requestId: 'deny-write' },
    );
    secondSocket.send(
      JSON.stringify({
        type: 'action.request',
        requestId: 'allow-stop',
        action: { type: 'session.stop', scope: { session_id: opened.sessionId } },
      }),
    );
    assert.deepEqual(
      await secondInbox.wait(
        (message) => message.type === 'action.result' && message.reason === 'permitted',
      ),
      { type: 'action.result', allowed: true, reason: 'permitted', requestId: 'allow-stop' },
    );
  } finally {
    if (firstSocket) await close(firstSocket);
    if (secondSocket) await close(secondSocket);
    await controlPlane.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
