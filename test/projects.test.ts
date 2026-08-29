import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { createProjectsSubsystem, type DetectInput } from '../src/projects/index.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-projects-'));
}

test('projects registry lists, saves, upserts, and removes projects atomically', async () => {
  const directory = temporaryDirectory();
  const registryPath = path.join(directory, 'registry', 'projects.json');
  const context = new TestContext();
  createProjectsSubsystem({ registryPath }).register(context);
  const action = { id: 'test', label: 'Run tests', prompt: 'Run the test suite' };
  try {
    assert.deepEqual(await command(context, COMMAND_NAMES.projectList), { projects: [] });
    assert.deepEqual(
      await command(context, COMMAND_NAMES.projectSave, {
        name: 'Vibecodium',
        path: '/workspace/vibecodium',
        description: 'Control plane',
        quickActions: [action],
      }),
      {
        project: {
          name: 'Vibecodium',
          path: '/workspace/vibecodium',
          description: 'Control plane',
          quickActions: [action],
          scope: 'project',
        },
      },
    );
    assert.deepEqual(await command(context, COMMAND_NAMES.projectList), {
      projects: [
        {
          name: 'Vibecodium',
          path: '/workspace/vibecodium',
          description: 'Control plane',
          quickActions: [action],
          scope: 'project',
        },
      ],
    });
    assert.deepEqual(
      await command(context, COMMAND_NAMES.projectSave, {
        name: 'Vibecodium',
        path: '/workspace/updated',
        description: 'Updated control plane',
        quickActions: [{ ...action, prompt: 'Run focused tests' }],
      }),
      {
        project: {
          name: 'Vibecodium',
          path: '/workspace/updated',
          description: 'Updated control plane',
          quickActions: [{ ...action, prompt: 'Run focused tests' }],
          scope: 'project',
        },
      },
    );
    assert.deepEqual(await command(context, COMMAND_NAMES.projectRemove, { name: 'Vibecodium' }), {
      removed: true,
    });
    assert.deepEqual(await command(context, COMMAND_NAMES.projectRemove, { name: 'Vibecodium' }), {
      removed: false,
    });
    assert.deepEqual(await command(context, COMMAND_NAMES.projectList), { projects: [] });

    fs.writeFileSync(registryPath, '{not-json');
    assert.deepEqual(await command(context, COMMAND_NAMES.projectList), { projects: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('project.detect parses fenced proposals, generates ids, and caps actions', async () => {
  const directory = temporaryDirectory();
  const registryPath = path.join(directory, 'projects.json');
  const proposals = Array.from({ length: 7 }, (_, index) => ({
    id: `ignored-${index}`,
    label: `Action ${index + 1}`,
    prompt: `Use action ${index + 1}`,
  }));
  let received: DetectInput | undefined;
  const context = new TestContext();
  createProjectsSubsystem({
    registryPath,
    detect: async (input) => {
      received = input;
      return `Reviewed repository.\n\n\`\`\`json\n${JSON.stringify(proposals)}\n\`\`\`\nDone.`;
    },
  }).register(context);
  try {
    assert.deepEqual(
      await command(context, COMMAND_NAMES.projectDetect, {
        path: directory,
        description: 'A useful project',
      }),
      {
        proposed: proposals.slice(0, 6).map((proposal) => ({
          id: proposal.label.toLowerCase().replaceAll(' ', '-'),
          label: proposal.label,
          prompt: proposal.prompt,
        })),
      },
    );
    assert.deepEqual(received, { path: directory, description: 'A useful project' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('project.detect returns no proposals for unparseable output', async () => {
  const context = new TestContext();
  createProjectsSubsystem({ detect: async () => 'agent failed without JSON' }).register(context);
  assert.deepEqual(await command(context, COMMAND_NAMES.projectDetect, { path: '/workspace' }), {
    proposed: [],
  });
});
