import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlPlane } from '../src/server/control-plane.js';
import {
  InboundListener,
  NtfyNotifier,
  createNotifySubsystem,
  isSafeInboundHost,
  signInboxRequest,
  type NotificationMessage,
  type Notifier,
} from '../src/notify/index.js';

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-notify-'));
}

function deliveredNotifier(messages: NotificationMessage[]): Notifier {
  return {
    name: 'ntfy',
    send(message) {
      messages.push(message);
      return Promise.resolve({ channel: 'ntfy', status: 'delivered' });
    },
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('routes an event to ntfy and appends notify_emitted', async () => {
  const directory = temporaryDirectory();
  const messages: NotificationMessage[] = [];
  const notify = createNotifySubsystem({
    filename: path.join(directory, 'notify.db'),
    defaultRules: [{ event_kind: 'verify_failed', severity: 'warn', channels: ['ntfy'] }],
    notifiers: { ntfy: deliveredNotifier(messages) },
  });
  const controlPlane = new ControlPlane({
    dataPath: path.join(directory, 'events.sqlite'),
    subsystems: [notify],
  });
  try {
    controlPlane.context.append('session-1', 'verify_failed', {
      stage: 'verify',
      error: 'failed',
    });
    await nextTurn();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.severity, 'warn');
    assert.deepEqual(
      controlPlane.eventStore.readAll().map((event) => event.type),
      ['verify_failed', 'notify_emitted'],
    );
    assert.equal(notify.notifications()[0]?.status, 'delivered');
  } finally {
    await controlPlane.stop();
    await notify.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('master switch suppresses notifications and dedup collapses identical bursts', async () => {
  const directory = temporaryDirectory();
  const messages: NotificationMessage[] = [];
  const notify = createNotifySubsystem({
    filename: path.join(directory, 'notify.db'),
    defaultRules: [
      { event_kind: 'verify_failed', severity: 'warn', channels: ['ntfy'] },
      { event_kind: 'action_requested', severity: 'action', channels: ['ntfy'] },
    ],
    notifiers: { ntfy: deliveredNotifier(messages) },
  });
  const controlPlane = new ControlPlane({
    dataPath: path.join(directory, 'events.sqlite'),
    subsystems: [notify],
  });
  try {
    notify.setMasterSwitch(false);
    controlPlane.context.append('s', 'verify_failed', { stage: 'v', error: 'x' });
    await nextTurn();
    assert.equal(messages.length, 0);
    assert.equal(notify.notifications().length, 0);

    notify.setMasterSwitch(true);
    controlPlane.context.append('s', 'verify_failed', { stage: 'v', error: 'x' });
    controlPlane.context.append('other', 'verify_failed', { stage: 'v', error: 'x' });
    await nextTurn();
    assert.equal(messages.length, 1);
    assert.equal(notify.notifications()[0]?.occurrences, 2);
    assert.equal(
      controlPlane.eventStore.readAll().filter((event) => event.type === 'notify_emitted').length,
      1,
    );
  } finally {
    await controlPlane.stop();
    await notify.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('quiet hours suppress info and warn while action punches through', async () => {
  const directory = temporaryDirectory();
  const messages: NotificationMessage[] = [];
  const notify = createNotifySubsystem({
    filename: path.join(directory, 'notify.db'),
    now: () => new Date('2026-08-28T02:00:00.000Z'),
    quietHours: { start: '00:00', end: '06:00', timezone: 'UTC' },
    defaultRules: [
      { event_kind: 'session_complete', severity: 'info', channels: ['ntfy'] },
      { event_kind: 'verify_failed', severity: 'warn', channels: ['ntfy'] },
      { event_kind: 'action_requested', severity: 'action', channels: ['ntfy'] },
    ],
    notifiers: { ntfy: deliveredNotifier(messages) },
  });
  const controlPlane = new ControlPlane({
    dataPath: path.join(directory, 'events.sqlite'),
    subsystems: [notify],
  });
  try {
    controlPlane.context.append('s', 'session_complete', { session_id: 's', provider: 'fake' });
    controlPlane.context.append('s', 'verify_failed', { stage: 'v', error: 'x' });
    controlPlane.context.append('s', 'action_requested', {
      request_id: 'r',
      action: 'approve',
      scope: { proposal_id: 'p' },
    });
    await nextTurn();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.severity, 'action');
    assert.equal(notify.notifications().length, 1);
  } finally {
    await controlPlane.stop();
    await notify.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('valid capability approval is single-use and appends proposal approval', async () => {
  const directory = temporaryDirectory();
  const notify = createNotifySubsystem({
    filename: path.join(directory, 'notify.db'),
    capabilityKeys: {
      current: { kid: 'current', secret: 'current-secret' },
      previous: { kid: 'previous', secret: 'previous-secret' },
    },
    inboxKeys: { current: { kid: 'inbox', secret: 'inbox-secret' } },
    defaultRules: [],
  });
  const controlPlane = new ControlPlane({
    dataPath: path.join(directory, 'events.sqlite'),
    subsystems: [notify],
  });
  try {
    const token = notify.mintCapabilityToken({
      proposal_id: 'proposal-1',
      signature: 'sig-1',
      action: 'approve_proposal',
      approval_event: 'proposal_approved',
    });
    const accepted = await notify.handleInbound({
      type: 'capability',
      token,
      stream_id: 'proposal-1',
    });
    assert.equal(accepted.accepted, true);
    assert.equal(notify.verifyCapabilityToken(token), undefined);
    const replay = await notify.handleInbound({
      type: 'capability',
      token,
      stream_id: 'proposal-1',
    });
    assert.equal(replay.accepted, false);
    assert.deepEqual(
      controlPlane.eventStore.readAll().map((event) => event.type),
      ['inbound_received', 'proposal_approved'],
    );
  } finally {
    await controlPlane.stop();
    await notify.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('custom inbox accepts previous HMAC key once and rejects replay or stale signatures', async () => {
  const directory = temporaryDirectory();
  let now = new Date('2026-08-28T12:00:00.000Z');
  const previous = { kid: 'old', secret: 'old-secret' } as const;
  const notify = createNotifySubsystem({
    filename: path.join(directory, 'notify.db'),
    now: () => now,
    defaultRules: [],
    inboxKeys: {
      current: { kid: 'new', secret: 'new-secret' },
      previous,
    },
  });
  const controlPlane = new ControlPlane({
    dataPath: path.join(directory, 'events.sqlite'),
    subsystems: [notify],
  });
  try {
    const body = JSON.stringify({ source: 'mailbox', request_id: 'in-1' });
    const timestamp = Math.floor(now.getTime() / 1000);
    const headers = {
      'x-vibecodium-kid': previous.kid,
      'x-vibecodium-timestamp': String(timestamp),
      'x-vibecodium-signature': signInboxRequest(body, timestamp, previous),
    };
    const accepted = await notify.handleInbound({ type: 'inbox', body, headers });
    assert.equal(accepted.accepted, true);
    const replay = await notify.handleInbound({ type: 'inbox', body, headers });
    assert.equal(replay.accepted, false);

    now = new Date('2026-08-28T13:00:00.000Z');
    const stale = await notify.handleInbound({ type: 'inbox', body, headers });
    assert.equal(stale.accepted, false);
    assert.equal(controlPlane.eventStore.readAll().length, 1);
  } finally {
    await controlPlane.stop();
    await notify.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('inbound HTTP listener handles a token callback on localhost', async () => {
  const directory = temporaryDirectory();
  const notify = createNotifySubsystem({
    filename: path.join(directory, 'notify.db'),
    defaultRules: [],
    capabilityKeys: { current: { kid: 'current', secret: 'secret' } },
  });
  const controlPlane = new ControlPlane({
    dataPath: path.join(directory, 'events.sqlite'),
    subsystems: [notify],
  });
  try {
    const address = await notify.startInbound();
    const token = notify.mintCapabilityToken({
      proposal_id: 'http-proposal',
      signature: 'http-signature',
      action: 'approve_proposal',
      approval_event: 'proposal_approved',
    });
    const response = await fetch(
      `${address.url}/notify/capability?token=${encodeURIComponent(token)}&decision=approve`,
      { method: 'POST' },
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as { accepted: boolean };
    assert.equal(result.accepted, true);
  } finally {
    await controlPlane.stop();
    await notify.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ntfy adapter posts action buttons and listener refuses public binds', async () => {
  let captured: { url: string; init: RequestInit | undefined } | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(null, { status: 200 });
  };
  const notifier = new NtfyNotifier({
    baseUrl: 'http://ntfy.local/',
    topic: 'ops',
    fetch: fetchMock,
  });
  await notifier.send({
    notification_id: 'n',
    signature: 's',
    event_kind: 'action_requested',
    severity: 'action',
    title: 'Approval',
    body: 'Approve?',
    actions: [{ label: 'Approve', url: 'http://127.0.0.1:4311/approve', method: 'POST' }],
  });
  assert.equal(captured?.url, 'http://ntfy.local/ops');
  assert.equal(captured?.init?.method, 'POST');
  assert.match(
    String(captured?.init?.headers && (captured.init.headers as Record<string, string>).Actions),
    /Approve/,
  );
  assert.equal(isSafeInboundHost('100.64.999.1'), false);
  assert.throws(() => new InboundListener(async () => ({ accepted: true }), { host: '0.0.0.0' }));
  assert.equal(isSafeInboundHost('100.100.10.5'), true);
  assert.equal(isSafeInboundHost('203.0.113.10'), false);
});
