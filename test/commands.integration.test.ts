import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import type { EventEnvelope, SessionOutputPayload } from '../src/contracts/events.js';
import { createSessionSubsystem } from '../src/session/index.js';
import { ControlPlane, type ControlPlaneAddress } from '../src/server/control-plane.js';
import { BASIC_BUILD_TEMPLATE, WorkflowEngine } from '../src/workflow/index.js';

type WireMessage = Record<string, unknown>;

function temporaryPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-commands-')), 'events.sqlite');
}

function connect(address: ControlPlaneAddress): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address.wsUrl);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitFor(
  socket: WebSocket,
  predicate: (message: WireMessage) => boolean,
): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', receive);
      reject(new Error('timed out waiting for WebSocket message'));
    }, 5_000);
    const receive = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', receive);
      resolve(message);
    };
    socket.on('message', receive);
  });
}

async function waitForEvents(
  plane: ControlPlane,
  stream_id: string,
  predicate: (events: EventEnvelope[]) => boolean,
): Promise<EventEnvelope[]> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const events = plane.eventStore.read(stream_id, 0);
    if (predicate(events)) return events;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for events');
}

test('POST session.open returns ids and streams ordered fake-provider events', async () => {
  const dataPath = temporaryPath();
  const plane = new ControlPlane({ dataPath, port: 0 });
  try {
    const address = await plane.start();
    const response = await fetch(`${address.httpUrl}/commands/session.open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'fake', prompt: 'hello world' }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { value: { session_id: string; stream_id: string } };
    assert.match(body.value.session_id, /^[0-9a-f-]{36}$/);
    assert.equal(body.value.stream_id, `session:${body.value.session_id}`);
    const firstTurn = await waitForEvents(plane, body.value.stream_id, (items) =>
      items.some((event) => event.type === 'turn_complete'),
    );
    const sendResponse = await fetch(`${address.httpUrl}/commands/session.send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: body.value.session_id, prompt: 'second prompt' }),
    });
    assert.equal(sendResponse.status, 200);
    assert.deepEqual((await sendResponse.json()).value, {
      stream_id: body.value.stream_id,
      turn: 2,
    });
    const events = await waitForEvents(
      plane,
      body.value.stream_id,
      (items) => items.filter((event) => event.type === 'turn_complete').length >= 2,
    );
    assert.deepEqual(firstTurn.filter((event) => event.type === 'turn_complete').length, 1);
    const stopResponse = await fetch(`${address.httpUrl}/commands/session.stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: body.value.session_id }),
    });
    assert.equal(stopResponse.status, 200);
    const completed = await waitForEvents(plane, body.value.stream_id, (items) =>
      items.some((event) => event.type === 'session_complete'),
    );
    assert.deepEqual(
      completed.map((event) => event.type),
      [
        'session_started',
        'session_output',
        'session_output',
        'turn_complete',
        'session_input',
        'session_output',
        'session_output',
        'turn_complete',
        'session_complete',
      ],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === 'session_output')
        .map((event) => (event.payload as SessionOutputPayload).index),
      [0, 1, 0, 1],
    );
  } finally {
    await plane.stop();
    fs.rmSync(path.dirname(dataPath), { recursive: true, force: true });
  }
});

test('WS command frame opens and stops a fake session', async () => {
  const dataPath = temporaryPath();
  const plane = new ControlPlane({ dataPath, port: 0 });
  let socket: WebSocket | undefined;
  try {
    const address = await plane.start();
    socket = await connect(address);
    socket.send(
      JSON.stringify({
        id: 'open-1',
        type: 'command',
        name: 'session.open',
        args: { provider: 'fake', prompt: new Array(500).fill('word').join(' ') },
      }),
    );
    const opened = await waitFor(socket, (message) => message.id === 'open-1');
    assert.equal(opened.type, 'result');
    const value = opened.value as { session_id: string; stream_id: string };
    socket.send(
      JSON.stringify({
        id: 'stop-1',
        type: 'command',
        name: 'session.stop',
        args: { session_id: value.session_id },
      }),
    );
    const stopped = await waitFor(socket, (message) => message.id === 'stop-1');
    assert.deepEqual(stopped.value, { stopped: true });
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    await plane.stop();
    fs.rmSync(path.dirname(dataPath), { recursive: true, force: true });
  }
});

test('workflow.run delegates start and loopback approval releases the workflow', async () => {
  const dataPath = temporaryPath();
  let engine: WorkflowEngine | undefined;
  const workflowSubsystem = {
    name: 'workflow',
    register(context: ConstructorParameters<typeof WorkflowEngine>[0]): void {
      engine = new WorkflowEngine(context, {
        templates: [BASIC_BUILD_TEMPLATE],
        podmanRunner: () => ({ ok: true, exit_code: 0, stdout: 'ok', stderr: '' }),
      });
      engine.register();
    },
  };
  const plane = new ControlPlane({
    dataPath,
    port: 0,
    subsystems: [createSessionSubsystem(), workflowSubsystem],
  });
  try {
    const address = await plane.start();
    const runResponse = await fetch(`${address.httpUrl}/commands/workflow.run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: 'basic-build' }),
    });
    const run = (await runResponse.json()) as { value: { stream_id: string } };
    const workflowId = run.value.stream_id.slice('workflow:'.length);
    assert.equal(engine?.get(workflowId)?.status, 'running');
    for (let index = 0; index < 4; index += 1) {
      engine?.advance({ workflow_id: workflowId });
    }
    const approveResponse = await fetch(`${address.httpUrl}/commands/workflow.approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream_id: run.value.stream_id }),
    });
    assert.equal(approveResponse.status, 200);
    assert.equal(engine?.get(workflowId)?.status, 'released');
  } finally {
    await plane.stop();
    fs.rmSync(path.dirname(dataPath), { recursive: true, force: true });
  }
});
