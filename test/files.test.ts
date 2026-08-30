import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { createFilesSubsystem } from '../src/files/index.js';

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

async function command(context: TestContext, name: string, args: unknown = {}): Promise<unknown> {
  const handler = context.commands.get(name);
  assert.ok(handler, `missing command ${name}`);
  return handler(args);
}

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-files-'));
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('files scope lists projects and shared children, and round-trips uploads/downloads', async () => {
  const root = temporaryDirectory();
  const project = path.join(root, 'project');
  const shared = path.join(root, 'shared');
  const registryPath = path.join(root, 'projects.json');
  const previousShared = process.env.VIBECODIUM_SHARED_DIR;
  const previousProjects = process.env.VIBECODIUM_PROJECTS_PATH;
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'notes.txt'), 'project notes');
  fs.writeFileSync(
    registryPath,
    JSON.stringify({ projects: [{ path: project, name: 'Project', scope: 'project' }] }),
  );
  process.env.VIBECODIUM_SHARED_DIR = shared;
  process.env.VIBECODIUM_PROJECTS_PATH = registryPath;
  const context = new TestContext();
  createFilesSubsystem().register(context);

  try {
    const sharedResult = (await command(context, COMMAND_NAMES.filesSharedDir)) as { path: string };
    assert.equal(sharedResult.path, shared);

    const roots = (await command(context, COMMAND_NAMES.filesList)) as {
      entries: readonly { path: string; is_dir: boolean }[];
      scope_roots: readonly string[];
    };
    assert.deepEqual(roots.scope_roots, [project, shared]);
    assert.deepEqual(
      roots.entries.map((entry) => ({ path: entry.path, is_dir: entry.is_dir })),
      [
        { path: project, is_dir: true },
        { path: shared, is_dir: true },
      ],
    );

    const projectListing = (await command(context, COMMAND_NAMES.filesList, { dir: project })) as {
      entries: readonly {
        name: string;
        path: string;
        is_dir: boolean;
        size?: number;
        mtime?: string;
      }[];
    };
    assert.deepEqual(
      projectListing.entries.map((entry) => entry.name),
      ['notes.txt', 'src'],
    );
    assert.equal(projectListing.entries[0]?.is_dir, false);
    assert.equal(projectListing.entries[0]?.size, Buffer.byteLength('project notes'));
    assert.equal(typeof projectListing.entries[0]?.mtime, 'string');

    const uploaded = (await command(context, COMMAND_NAMES.filesUpload, {
      session_id: 'session-1',
      name: 'nested/attachment.txt',
      content_base64: Buffer.from('uploaded bytes').toString('base64'),
      mime: 'text/plain',
    })) as { path: string; size: number };
    assert.equal(uploaded.path, path.join(shared, 'session-session-1', 'attachment.txt'));
    assert.equal(uploaded.size, Buffer.byteLength('uploaded bytes'));
    assert.equal(fs.readFileSync(uploaded.path, 'utf8'), 'uploaded bytes');

    const downloaded = (await command(context, COMMAND_NAMES.filesDownload, {
      path: uploaded.path,
    })) as { name: string; mime: string; content_base64: string; size: number };
    assert.deepEqual(downloaded, {
      name: 'attachment.txt',
      mime: 'text/plain',
      content_base64: Buffer.from('uploaded bytes').toString('base64'),
      size: Buffer.byteLength('uploaded bytes'),
    });

    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    await assert.rejects(
      command(context, COMMAND_NAMES.filesDownload, { path: outside }),
      /outside allowed filesystem scope/,
    );
    await assert.rejects(
      command(context, COMMAND_NAMES.filesList, { dir: path.join(project, '..') }),
      /outside allowed filesystem scope/,
    );

    fs.symlinkSync(outside, path.join(project, 'outside-link.txt'));
    await assert.rejects(
      command(context, COMMAND_NAMES.filesDownload, {
        path: path.join(project, 'outside-link.txt'),
      }),
      /outside allowed filesystem scope/,
    );
  } finally {
    restoreEnvironment('VIBECODIUM_SHARED_DIR', previousShared);
    restoreEnvironment('VIBECODIUM_PROJECTS_PATH', previousProjects);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('files.upload rejects content over 200 MB before writing', async () => {
  const root = temporaryDirectory();
  const shared = path.join(root, 'shared');
  const registryPath = path.join(root, 'projects.json');
  const previousShared = process.env.VIBECODIUM_SHARED_DIR;
  const previousProjects = process.env.VIBECODIUM_PROJECTS_PATH;
  fs.writeFileSync(registryPath, JSON.stringify({ projects: [] }));
  process.env.VIBECODIUM_SHARED_DIR = shared;
  process.env.VIBECODIUM_PROJECTS_PATH = registryPath;
  const context = new TestContext();
  createFilesSubsystem().register(context);
  try {
    const tooLargeBase64 = 'A'.repeat(Math.ceil(((200 * 1024 * 1024 + 1) * 4) / 3));
    await assert.rejects(
      command(context, COMMAND_NAMES.filesUpload, {
        session_id: 'too-large',
        name: 'large.bin',
        content_base64: tooLargeBase64,
      }),
      /upload exceeds 200 MB limit/,
    );
    assert.equal(fs.existsSync(shared), false);
  } finally {
    restoreEnvironment('VIBECODIUM_SHARED_DIR', previousShared);
    restoreEnvironment('VIBECODIUM_PROJECTS_PATH', previousProjects);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
