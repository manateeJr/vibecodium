import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { EventKind, EventPayload } from '../src/contracts/events.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { REPORT_RETENTION_MS, type ReportRecord } from '../src/contracts/report-commands.js';
import { createReportsSubsystem, type SessionSubsystemLike } from '../src/reports/index.js';
import { ReportStore, type ReportEnvelope } from '../src/reports/store.js';

test('report commands list, get, pin, and dismiss durable records', async () => {
  const root = temporaryRoot('vibecodium-reports-commands-');
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const store = new ReportStore({ sharedRoot: root, now: () => now });
  const context = new TestContext();
  const subsystem = createReportsSubsystem({
    store,
    sessions: stubSessions(),
    sweepIntervalMs: 60_000,
  });
  subsystem.register(context);
  try {
    const first = await subsystem.create(envelope('first'), []);
    now += 1_000;
    const second = await subsystem.create(envelope('second'), []);

    const listed = (await command(context, COMMAND_NAMES.reportList)) as {
      reports: readonly ReportRecord[];
    };
    assert.deepEqual(
      listed.reports.map((report) => report.title),
      ['second', 'first'],
    );
    const fetched = (await command(context, COMMAND_NAMES.reportGet, { id: first.id })) as {
      report: ReportRecord;
      body: unknown;
      body_path: string;
    };
    assert.equal(fetched.report.id, first.id);
    assert.deepEqual(fetched.body, { title: 'first' });
    assert.equal(fetched.body_path, store.bodyPath(first.id));

    assert.deepEqual(
      await command(context, COMMAND_NAMES.reportPin, { id: first.id, pinned: true }),
      {
        pinned: true,
      },
    );
    assert.equal((await store.get(first.id)).report.pinned, true);
    assert.deepEqual(await command(context, COMMAND_NAMES.reportDismiss, { id: first.id }), {
      dismissed: true,
    });
    assert.equal(fs.existsSync(path.join(root, first.id)), false);
    await assert.rejects(store.get(first.id), /report not found/);
    assert.equal(
      (
        (await command(context, COMMAND_NAMES.reportDismiss, { id: first.id })) as {
          dismissed: boolean;
        }
      ).dismissed,
      false,
    );
    assert.equal(
      context.events.some((event) => event.type === 'report_received'),
      true,
    );
    assert.equal(second.id.length > 0, true);
  } finally {
    subsystem.stopSweep();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('report promotion prepends orientation and attaches body and images', async () => {
  const root = temporaryRoot('vibecodium-reports-promote-');
  const opens: unknown[] = [];
  const sends: unknown[] = [];
  const sessions: SessionSubsystemLike = {
    open: async (command) => {
      opens.push(command);
      return { stream_id: 'stream:new', session_id: 'session:new' };
    },
    send: (command) => {
      sends.push(command);
      return { stream_id: 'stream:existing', turn: 1 };
    },
  };
  const store = new ReportStore({ sharedRoot: root });
  const context = new TestContext();
  const subsystem = createReportsSubsystem({ store, sessions, sweepIntervalMs: 60_000 });
  subsystem.register(context);
  try {
    const report = await subsystem.create(envelope('promoted', 'Summary', 'Phone', 'Note'), [
      { filename: 'screen.png', contentType: 'image/png', data: Buffer.from('png') },
      { filename: 'second.jpg', contentType: 'image/jpeg', data: Buffer.from('jpg') },
    ]);
    const promote = context.commands.get(COMMAND_NAMES.reportPromote);
    assert.ok(promote);
    const created = (await promote({
      id: report.id,
      target: 'new',
      provider: 'omp',
      cwd: '/workspace',
      project: 'demo',
    })) as { stream_id: string; session_id: string };
    assert.deepEqual(created, { stream_id: 'stream:new', session_id: 'session:new' });
    const openCommand = opens[0] as {
      prompt: string;
      provider: string;
      origin: string;
      source: string;
    };
    assert.equal(openCommand.provider, 'omp');
    assert.equal(openCommand.origin, 'operator');
    assert.equal(openCommand.source, 'pocket');
    assert.equal(openCommand.prompt.startsWith('Debug report: promoted\n'), true);
    assert.equal(
      openCommand.prompt.includes(
        'App: ultrack · Kind: debug · Captured: 2026-08-31T12:00:00.000Z · Device: Phone\n',
      ),
      true,
    );
    assert.equal(
      openCommand.prompt.indexOf('Summary') < openCommand.prompt.indexOf('Attached file:'),
      true,
    );
    assert.equal(openCommand.prompt.includes('Note: Note'), true);
    assert.equal(openCommand.prompt.includes(`Attached file: ${store.bodyPath(report.id)}`), true);
    for (const attachmentPath of store.attachmentPaths(report)) {
      assert.equal(openCommand.prompt.includes(`Attached file: ${attachmentPath}`), true);
    }

    const existing = (await promote({
      id: report.id,
      target: 'existing',
      session_id: 'session:existing',
    })) as { stream_id: string; session_id: string };
    assert.deepEqual(existing, { stream_id: 'stream:existing', session_id: 'session:existing' });
    const sendCommand = sends[0] as { session_id: string; prompt: string };
    assert.equal(sendCommand.session_id, 'session:existing');
    assert.equal(sendCommand.prompt, openCommand.prompt);
    await assert.rejects(
      async () => promote({ id: report.id, target: 'existing' }),
      /session_id is required/,
    );
  } finally {
    subsystem.stopSweep();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('report sweep removes expired unpinned records but keeps pinned and fresh records', async () => {
  const root = temporaryRoot('vibecodium-reports-sweep-');
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const store = new ReportStore({ sharedRoot: root, now: () => now });
  const subsystem = createReportsSubsystem({
    store,
    sessions: stubSessions(),
    sweepIntervalMs: 60_000,
  });
  const context = new TestContext();
  subsystem.register(context);
  try {
    const old = await subsystem.create(envelope('old'), []);
    const pinned = await subsystem.create(envelope('pinned'), []);
    const pin = context.commands.get(COMMAND_NAMES.reportPin);
    assert.ok(pin);
    await pin({ id: pinned.id, pinned: true });
    now += REPORT_RETENTION_MS + 1;
    const fresh = await subsystem.create(envelope('fresh'), []);
    assert.equal(await subsystem.sweepNow(), 1);
    assert.equal(fs.existsSync(path.join(root, old.id)), false);
    assert.equal(fs.existsSync(path.join(root, pinned.id)), true);
    assert.equal(fs.existsSync(path.join(root, fresh.id)), true);
  } finally {
    subsystem.stopSweep();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('report attachments use basenames and never escape their report directory', async () => {
  const root = temporaryRoot('vibecodium-reports-attachment-');
  const store = new ReportStore({ sharedRoot: root });
  try {
    const report = await store.create(envelope('path'), [
      { filename: '../evil.png', data: Buffer.from('image') },
    ]);
    const attachmentPath = store.attachmentPaths(report)[0];
    assert.ok(attachmentPath);
    assert.equal(path.basename(attachmentPath), 'evil.png');
    assert.equal(path.dirname(attachmentPath), path.join(root, report.id));
    assert.equal(fs.existsSync(path.join(root, 'evil.png')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function envelope(title: string, summary?: string, device?: string, note?: string): ReportEnvelope {
  return {
    app: 'ultrack',
    kind: 'debug',
    schemaVersion: 1,
    capturedAt: '2026-08-31T12:00:00.000Z',
    title,
    ...(summary === undefined ? {} : { summary }),
    ...(device === undefined ? {} : { device }),
    ...(note === undefined ? {} : { note }),
    body: { title },
  };
}

function stubSessions(): SessionSubsystemLike {
  return {
    open: async () => ({ stream_id: 'stream', session_id: 'session' }),
    send: () => ({ stream_id: 'stream', turn: 1 }),
  };
}

async function command(context: TestContext, name: string, args?: unknown): Promise<unknown> {
  const handler = context.commands.get(name);
  assert.ok(handler, `missing command ${name}`);
  return handler(args);
}

class TestContext implements SubsystemContext {
  public readonly commands = new Map<string, CommandHandler>();
  public readonly events: Array<{ readonly type: EventKind; readonly payload: EventPayload }> = [];

  public registerProjector(): void {}

  public registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  public registerListener(): void {}

  public append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number {
    this.events.push({ type, payload });
    assert.equal(stream_id, 'reports');
    return this.events.length;
  }

  public subscribe(): () => void {
    return () => undefined;
  }
}

function temporaryRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
