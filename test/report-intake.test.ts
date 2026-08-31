import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { REPORT_INTAKE_PATH } from '../src/contracts/report-commands.js';
import { createReportsSubsystem } from '../src/reports/index.js';
import { ControlPlane } from '../src/server/control-plane.js';
import { ReportStore } from '../src/reports/store.js';
import { handleReportIntake } from '../src/server/report-intake.js';

type MultipartInput = {
  readonly name: string;
  readonly value: string | Buffer;
  readonly filename?: string;
  readonly contentType?: string;
};

function multipartBody(boundary: string, parts: readonly MultipartInput[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const filename = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    const contentType =
      part.contentType === undefined ? '' : `Content-Type: ${part.contentType}\r\n`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\n${contentType}\r\n`,
      ),
    );
    chunks.push(typeof part.value === 'string' ? Buffer.from(part.value) : part.value);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function incomingRequest(
  body: Buffer,
  contentType: string,
  remoteAddress = '127.0.0.1',
  authorization?: string,
): IncomingMessage {
  const request = Readable.from([body]) as Readable & {
    headers: IncomingMessage['headers'];
    socket: { readonly remoteAddress: string };
  };
  request.headers = {
    'content-type': contentType,
    ...(authorization === undefined ? {} : { authorization }),
  };
  request.socket = { remoteAddress };
  return request as unknown as IncomingMessage;
}

function responseCapture(): {
  readonly response: ServerResponse;
  readonly status: () => number;
  readonly json: () => unknown;
} {
  let statusCode = 0;
  let body = Buffer.alloc(0);
  const response = {
    writeHead(status: number): void {
      statusCode = status;
    },
    end(value?: string | Buffer): void {
      body = value === undefined ? Buffer.alloc(0) : Buffer.from(value);
    },
  } as unknown as ServerResponse;
  return {
    response,
    status: () => statusCode,
    json: () => JSON.parse(body.toString('utf8')) as unknown,
  };
}

function temporaryRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('enveloped multipart intake stores opaque body and attachments', async () => {
  const root = temporaryRoot('vibecodium-report-intake-');
  try {
    const store = new ReportStore({ sharedRoot: root });
    const boundary = 'envelope-boundary';
    const payload = {
      app: 'ultrack',
      kind: 'debug',
      schemaVersion: 3,
      capturedAt: '2026-08-31T12:00:00.000Z',
      title: 'A device report',
      summary: 'A short summary',
      device: 'Samsung',
      note: 'Keep this note',
      body: { nested: ['opaque', { value: 42 }] },
    };
    const capture = responseCapture();
    await handleReportIntake(
      incomingRequest(
        multipartBody(boundary, [
          { name: 'envelope', contentType: 'application/json', value: JSON.stringify(payload) },
          {
            name: 'attachments',
            filename: 'screen.png',
            contentType: 'image/png',
            value: 'png bytes',
          },
        ]),
        `multipart/form-data; boundary=${boundary}`,
      ),
      capture.response,
      { store },
    );
    assert.equal(capture.status(), 200);
    const result = capture.json() as { id: string; path: string };
    const stored = await store.get(result.id);
    assert.equal(result.path, path.dirname(stored.bodyPath));
    assert.equal(stored.report.app, payload.app);
    assert.equal(stored.report.kind, payload.kind);
    assert.equal(stored.report.schemaVersion, payload.schemaVersion);
    assert.equal(stored.report.capturedAt, payload.capturedAt);
    assert.equal(stored.report.title, payload.title);
    assert.equal(stored.report.summary, payload.summary);
    assert.equal(stored.report.device, payload.device);
    assert.equal(stored.report.note, payload.note);
    assert.deepEqual(stored.body, payload.body);
    assert.deepEqual(stored.report.attachments, [
      { filename: 'screen.png', contentType: 'image/png', bytes: Buffer.byteLength('png bytes') },
    ]);
    assert.equal(fs.readFileSync(path.join(result.path, 'screen.png'), 'utf8'), 'png bytes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bare JSON intake wraps the whole payload without inspecting it', async () => {
  const root = temporaryRoot('vibecodium-report-bare-');
  try {
    const store = new ReportStore({ sharedRoot: root });
    const payload = { message: 'raw', body: { nested: true } };
    const capture = responseCapture();
    await handleReportIntake(
      incomingRequest(Buffer.from(JSON.stringify(payload)), 'application/json'),
      capture.response,
      { store },
    );
    assert.equal(capture.status(), 200);
    const result = capture.json() as { id: string };
    const stored = await store.get(result.id);
    assert.equal(stored.report.app, 'unknown');
    assert.equal(stored.report.kind, 'raw');
    assert.deepEqual(stored.body, payload);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('control plane routes report intake and records a report event', async () => {
  const root = temporaryRoot('vibecodium-report-plane-');
  const store = new ReportStore({ sharedRoot: root });
  const reports = createReportsSubsystem({
    store,
    sessions: {
      open: async () => ({ stream_id: 'stream', session_id: 'session' }),
      send: () => ({ stream_id: 'stream', turn: 1 }),
    },
    sweepIntervalMs: 60_000,
  });
  const plane = new ControlPlane({
    dataPath: ':memory:',
    port: 0,
    subsystems: [reports],
  });
  try {
    const address = await plane.start();
    const upload = await fetch(`${address.httpUrl}${REPORT_INTAKE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'plane' }),
    });
    assert.equal(upload.status, 200);
    const result = (await upload.json()) as { id: string; path: string };
    assert.equal(result.path, path.join(root, result.id));
    const events = plane.eventStore.read('reports');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'report_received');
    assert.equal((events[0]?.payload as { app: string }).app, 'unknown');
  } finally {
    await plane.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('off-loopback intake requires a valid bearer capability token', async () => {
  const root = temporaryRoot('vibecodium-report-auth-');
  try {
    const store = new ReportStore({ sharedRoot: root });
    const body = Buffer.from(JSON.stringify({ raw: true }));
    const denied = responseCapture();
    await handleReportIntake(
      incomingRequest(body, 'application/json', '203.0.113.5'),
      denied.response,
      { store, verifyToken: (token) => token === 'valid-token' },
    );
    assert.equal(denied.status(), 401);
    assert.deepEqual(denied.json(), { error: 'unauthorized' });

    const accepted = responseCapture();
    await handleReportIntake(
      incomingRequest(body, 'application/json', '203.0.113.5', 'Bearer valid-token'),
      accepted.response,
      { store, verifyToken: (token) => token === 'valid-token' },
    );
    assert.equal(accepted.status(), 200);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intake rejects payloads over the configured cap', async () => {
  const root = temporaryRoot('vibecodium-report-cap-');
  try {
    const capture = responseCapture();
    await handleReportIntake(
      incomingRequest(Buffer.from('123456789'), 'application/json'),
      capture.response,
      { store: new ReportStore({ sharedRoot: root }), maxBytes: 8 },
    );
    assert.equal(capture.status(), 413);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('traversal attachment names are stored as basenames inside the report directory', async () => {
  const root = temporaryRoot('vibecodium-report-path-');
  try {
    const store = new ReportStore({ sharedRoot: root });
    const boundary = 'path-boundary';
    const capture = responseCapture();
    await handleReportIntake(
      incomingRequest(
        multipartBody(boundary, [
          { name: 'envelope', value: JSON.stringify({ app: 'ultrack', body: { ok: true } }) },
          { name: 'attachments', filename: '../evil.png', value: 'image' },
        ]),
        `multipart/form-data; boundary=${boundary}`,
      ),
      capture.response,
      { store },
    );
    const result = capture.json() as { id: string; path: string };
    const stored = await store.get(result.id);
    const attachmentPath = store.attachmentPaths(stored.report)[0];
    assert.ok(attachmentPath);
    assert.equal(path.basename(attachmentPath), 'evil.png');
    assert.equal(path.dirname(attachmentPath), result.path);
    assert.equal(fs.existsSync(path.join(root, 'evil.png')), false);
    assert.equal(fs.readFileSync(attachmentPath, 'utf8'), 'image');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
