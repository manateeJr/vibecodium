import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { createFilesSubsystem } from '../src/files/index.js';
import { ControlPlane } from '../src/server/control-plane.js';
import { MultipartError, parseMultipart } from '../src/server/multipart.js';

type Part = { readonly name: string; readonly value: string | Buffer; readonly filename?: string };

function multipartBody(boundary: string, parts: readonly Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const filename = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\n\r\n`,
      ),
    );
    chunks.push(typeof part.value === 'string' ? Buffer.from(part.value) : part.value);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function request(
  body: Buffer,
  contentType: string,
): Pick<IncomingRequest, 'headers'> & AsyncIterable<Buffer> {
  const stream = Readable.from([body]) as Readable & { headers: Record<string, string> };
  stream.headers = { 'content-type': contentType };
  return stream as Pick<IncomingRequest, 'headers'> & AsyncIterable<Buffer>;
}

type IncomingRequest = { headers: Record<string, string> };

test('multipart parser handles a single binary file and sanitizes traversal names', async () => {
  const boundary = 'test-boundary';
  const form = await parseMultipart(
    request(
      multipartBody(boundary, [{ name: 'file', filename: '../../evil.txt', value: 'file bytes' }]),
      `multipart/form-data; boundary=${boundary}`,
    ),
  );
  assert.equal(form.file.filename, 'evil.txt');
  assert.deepEqual(form.file.content, Buffer.from('file bytes'));
  assert.deepEqual(form.fields, {});
});

test('multipart parser returns file, note, and project fields', async () => {
  const boundary = 'fields-boundary';
  const form = await parseMultipart(
    request(
      multipartBody(boundary, [
        { name: 'note', value: 'hello' },
        { name: 'project', value: 'demo' },
        { name: 'file', filename: 'report.txt', value: Buffer.from([0, 1, 2, 3]) },
      ]),
      `multipart/form-data; boundary="${boundary}"`,
    ),
  );
  assert.equal(form.file.filename, 'report.txt');
  assert.deepEqual([...form.file.content], [0, 1, 2, 3]);
  assert.deepEqual(form.fields, { note: 'hello', project: 'demo' });
});

test('multipart parser rejects missing boundaries and oversized bodies', async () => {
  const body = multipartBody('boundary', [{ name: 'file', filename: 'x.txt', value: 'x' }]);
  await assert.rejects(
    parseMultipart(request(body, 'multipart/form-data')),
    (error: unknown) => error instanceof MultipartError && error.statusCode === 400,
  );
  await assert.rejects(
    parseMultipart(request(Buffer.alloc(11), 'multipart/form-data; boundary=boundary'), 10),
    (error: unknown) => error instanceof MultipartError && error.statusCode === 413,
  );
});

test('share intake stages metadata and files.shared_staged reads it back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-share-intake-'));
  const shared = path.join(root, 'shared');
  const previousShared = process.env.VIBECODIUM_SHARED_DIR;
  process.env.VIBECODIUM_SHARED_DIR = shared;
  const plane = new ControlPlane({
    dataPath: ':memory:',
    port: 0,
    subsystems: [createFilesSubsystem({ sharedDir: shared })],
  });
  try {
    const address = await plane.start();
    const boundary = 'integration-boundary';
    const upload = await fetch(`${address.httpUrl}/share-intake`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(
        multipartBody(boundary, [
          { name: 'file', filename: '../shared.txt', value: 'shared bytes' },
          { name: 'note', value: 'hello' },
          { name: 'project', value: 'demo' },
        ]),
      ),
    });
    assert.equal(upload.status, 200);
    const staged = (await upload.json()) as { token: string; path: string };
    assert.match(staged.token, /^[0-9a-f-]{36}$/);
    assert.equal(fs.readFileSync(staged.path, 'utf8'), 'shared bytes');
    assert.equal(path.basename(staged.path), 'shared.txt');
    assert.equal(fs.existsSync(path.join(shared, staged.token, '.vibecodium-share.json')), true);

    const metadataResponse = await fetch(`${address.httpUrl}/commands/files.shared_staged`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: staged.token }),
    });
    assert.equal(metadataResponse.status, 200);
    assert.deepEqual((await metadataResponse.json()) as unknown, {
      value: {
        files: [{ name: 'shared.txt', path: staged.path, size: Buffer.byteLength('shared bytes') }],
        note: 'hello',
        project: 'demo',
      },
    });

    const context = new TestContext();
    createFilesSubsystem({ sharedDir: shared }).register(context);
    const stagedCommand = context.commands.get(COMMAND_NAMES.filesSharedStaged);
    assert.ok(stagedCommand);
    await assert.rejects(async () => {
      await stagedCommand({ token: '../escape' });
    }, /single path segment/);
    await assert.rejects(async () => {
      await stagedCommand({ token: 'missing-token' });
    }, /unknown share token/);
  } finally {
    await plane.stop();
    if (previousShared === undefined) delete process.env.VIBECODIUM_SHARED_DIR;
    else process.env.VIBECODIUM_SHARED_DIR = previousShared;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

class TestContext implements SubsystemContext {
  public readonly commands = new Map<string, CommandHandler>();

  public registerProjector(): void {}
  public registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }
  public registerListener(): void {}
  public append(): number {
    return 1;
  }
  public subscribe(): () => void {
    return () => undefined;
  }
}
