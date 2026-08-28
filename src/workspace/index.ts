import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMAND_NAMES, type WorkspaceEntry } from '../contracts/commands.js';
import type { Subsystem } from '../contracts/subsystem.js';

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
    },
  };
}
