import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  COMMAND_NAMES,
  type WorkspaceEntry,
  type WorkspaceStatusResult,
} from '../contracts/commands.js';
import type { Subsystem } from '../contracts/subsystem.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 1_000;
const GIT_MAX_BUFFER = 64 * 1024;

export interface WorkspaceSubsystemOptions {
  readonly roots?: readonly string[];
}

export function createWorkspaceSubsystem(options: WorkspaceSubsystemOptions = {}): Subsystem {
  const roots = options.roots ??
    process.env.VIBECODIUM_WORKSPACE_ROOTS?.split(':') ?? [os.homedir()];
  return {
    name: 'workspace',
    register(context) {
      context.registerCommand(COMMAND_NAMES.workspaceList, () => {
        const byPath = new Map<string, WorkspaceEntry>();
        for (const root of roots) {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(root, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const workspace = { name: entry.name, path: path.join(root, entry.name) };
            byPath.set(workspace.path, workspace);
          }
        }
        return {
          workspaces: [...byPath.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, 200),
        };
      });
      context.registerCommand(COMMAND_NAMES.workspaceStatus, (command) => workspaceStatus(command));
    },
  };
}

function workspaceStatus(command: unknown): Promise<WorkspaceStatusResult> {
  if (!isWorkspaceStatusCommand(command)) return Promise.resolve(noGitStatus());
  return readWorkspaceStatus(command.path);
}

async function readWorkspaceStatus(workspacePath: string): Promise<WorkspaceStatusResult> {
  const branchOutput = await gitOutput(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchOutput === undefined) return noGitStatus();
  const dirtyOutput = await gitOutput(workspacePath, ['status', '--porcelain']);
  if (dirtyOutput === undefined) return noGitStatus();

  let branch = branchOutput || 'detached';
  if (branch === 'HEAD') {
    branch = (await gitOutput(workspacePath, ['rev-parse', '--short', 'HEAD'])) ?? 'detached';
  }
  const result: WorkspaceStatusResult = {
    branch,
    dirty: dirtyOutput.length > 0,
  };
  const upstreamOutput = await gitOutput(workspacePath, [
    'rev-list',
    '--left-right',
    '--count',
    '@{u}...HEAD',
  ]);
  if (upstreamOutput) {
    const counts = upstreamOutput.split(/\s+/).map(Number);
    if (counts.length === 2 && counts.every(Number.isInteger)) {
      const behind = counts[0];
      const ahead = counts[1];
      if (behind !== undefined && ahead !== undefined) return { ...result, ahead, behind };
    }
  }
  return result;
}

async function gitOutput(
  workspacePath: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspacePath, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

function isWorkspaceStatusCommand(command: unknown): command is { readonly path: string } {
  return (
    typeof command === 'object' &&
    command !== null &&
    'path' in command &&
    typeof command.path === 'string'
  );
}

function noGitStatus(): WorkspaceStatusResult {
  return { branch: '(no git)', dirty: false };
}
