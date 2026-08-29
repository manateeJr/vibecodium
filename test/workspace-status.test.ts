import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES, type WorkspaceStatusResult } from '../src/contracts/commands.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { createWorkspaceSubsystem } from '../src/workspace/index.js';

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-workspace-status-'));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function statusHandler(): CommandHandler {
  const commands = new Map<string, CommandHandler>();
  createWorkspaceSubsystem().register({
    registerCommand(name: string, handler: CommandHandler) {
      commands.set(name, handler);
    },
  } as unknown as SubsystemContext);
  const handler = commands.get(COMMAND_NAMES.workspaceStatus);
  assert.ok(handler);
  return handler;
}

test('workspace.status reports branch and dirty transitions', async () => {
  const repository = temporaryDirectory();
  try {
    git(repository, ['init', '-q']);
    git(repository, ['config', 'user.email', 'test@example.com']);
    git(repository, ['config', 'user.name', 'Vibecodium Test']);
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'clean\n');
    git(repository, ['add', 'tracked.txt']);
    git(repository, ['commit', '-qm', 'initial']);
    git(repository, ['branch', '-M', 'main']);

    const status = statusHandler();
    assert.deepEqual(await status({ path: repository }), {
      branch: 'main',
      dirty: false,
    } satisfies WorkspaceStatusResult);

    fs.appendFileSync(path.join(repository, 'tracked.txt'), 'dirty\n');
    assert.deepEqual(await status({ path: repository }), {
      branch: 'main',
      dirty: true,
    } satisfies WorkspaceStatusResult);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workspace.status falls back for a non-git path', async () => {
  const directory = temporaryDirectory();
  try {
    const status = statusHandler();
    assert.deepEqual(await status({ path: directory }), {
      branch: '(no git)',
      dirty: false,
    } satisfies WorkspaceStatusResult);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
