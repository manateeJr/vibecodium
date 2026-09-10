import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import { MEDIA_ATTACH_COMMAND } from '../src/contracts/media-commands.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { createMediaSubsystem } from '../src/media/index.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

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

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-media-test-'));
}

async function attach(mediaDir: string, args: unknown): Promise<{ path: string; size: number }> {
  const subsystem = createMediaSubsystem({ mediaDir });
  const context = new TestContext();
  subsystem.register(context);
  const handler = context.commands.get(COMMAND_NAMES.mediaAttach);
  assert.ok(handler, 'missing command media.attach');
  return (await handler(args)) as { path: string; size: number };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

test('media.attach command name is media.attach', () => {
  assert.equal(MEDIA_ATTACH_COMMAND, 'media.attach');
  assert.equal(COMMAND_NAMES.mediaAttach, 'media.attach');
});

for (const [label, bytes, extension] of [
  ['JPEG', JPEG, '.jpg'],
  ['PNG', PNG, '.png'],
  ['GIF', GIF, '.gif'],
  ['WebP', WEBP, '.webp'],
] as const) {
  test(`media.attach stores ${label} bytes and returns an absolute path`, async () => {
    const mediaDir = temporaryDirectory();
    try {
      const result = await attach(mediaDir, {
        session_id: 'sess-1',
        image_base64: bytes.toString('base64'),
        mime: 'image/jpeg',
      });
      assert.equal(result.size, bytes.length);
      assert.ok(path.isAbsolute(result.path), 'path must be absolute');
      assert.equal(path.extname(result.path), extension);
      assert.equal(path.dirname(result.path), path.join(mediaDir, 'sess-1'));
      assert.deepEqual(fs.readFileSync(result.path), bytes);
    } finally {
      fs.rmSync(mediaDir, { recursive: true, force: true });
    }
  });
}

test('media.attach rejects SVG and HTML payloads', async () => {
  const mediaDir = temporaryDirectory();
  try {
    await assert.rejects(
      attach(mediaDir, {
        session_id: 'sess-1',
        image_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
      }),
      /unsupported image type/,
    );
    await assert.rejects(
      attach(mediaDir, {
        session_id: 'sess-1',
        image_base64: Buffer.from('<html><body>nope</body></html>').toString('base64'),
        mime: 'image/svg+xml',
      }),
      /unsupported image type/,
    );
  } finally {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('media.attach rejects oversize payloads before and after decode', async () => {
  const mediaDir = temporaryDirectory();
  try {
    await assert.rejects(
      attach(mediaDir, {
        session_id: 'sess-1',
        image_base64: 'A'.repeat(21 * 1024 * 1024),
      }),
      /exceeds 15 MB limit/,
    );
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    JPEG.copy(oversized);
    await assert.rejects(
      attach(mediaDir, {
        session_id: 'sess-1',
        image_base64: oversized.toString('base64'),
      }),
      /exceeds 15 MB limit/,
    );
  } finally {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('media.attach rejects empty image data', async () => {
  const mediaDir = temporaryDirectory();
  try {
    await assert.rejects(
      attach(mediaDir, { session_id: 'sess-1', image_base64: '   ' }),
      /image_base64 must contain image data/,
    );
  } finally {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('media.attach rejects bad session_id segments', async () => {
  const mediaDir = temporaryDirectory();
  try {
    for (const session_id of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', '/abs']) {
      await assert.rejects(
        attach(mediaDir, {
          session_id,
          image_base64: JPEG.toString('base64'),
        }),
        /session_id/,
        `expected rejection for ${JSON.stringify(session_id)}`,
      );
    }
  } finally {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('media.attach tolerates data-URL prefixes and whitespace', async () => {
  const mediaDir = temporaryDirectory();
  try {
    const encoded = PNG.toString('base64');
    const spaced = `${encoded.slice(0, 16)}\n  ${encoded.slice(16, 32)}\r\n${encoded.slice(32)}`;
    const plain = await attach(mediaDir, {
      session_id: 'sess-1',
      image_base64: spaced,
    });
    assert.equal(plain.size, PNG.length);
    const prefixed = await attach(mediaDir, {
      session_id: 'sess-1',
      image_base64: `data:image/png;base64,${encoded}`,
      filename: 'photo.png',
    });
    assert.equal(prefixed.size, PNG.length);
    assert.equal(path.extname(prefixed.path), '.png');
  } finally {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('media.attach rejects non-image mime hints', async () => {
  const mediaDir = temporaryDirectory();
  try {
    await assert.rejects(
      attach(mediaDir, {
        session_id: 'sess-1',
        image_base64: JPEG.toString('base64'),
        mime: 'text/html',
      }),
      /image\/\*/,
    );
  } finally {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});
