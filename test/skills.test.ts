import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES, type SkillDef } from '../src/contracts/commands.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { createSkillsSubsystem } from '../src/skills/index.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-skills-'));
}

test('skills library supports built-ins, custom persistence, adoption, invocation, and drafting', async () => {
  const directory = temporaryDirectory();
  const skillsPath = path.join(directory, 'nested', 'skills.json');
  const previousPath = process.env.VIBECODIUM_SKILLS_PATH;
  process.env.VIBECODIUM_SKILLS_PATH = skillsPath;
  let completionCalls = 0;
  const draftDef: SkillDef = {
    id: 'drafted-skill',
    name: 'Drafted Skill',
    body: 'Investigate {target} and report the evidence.',
    params: [{ name: 'target', type: 'text', required: true, source: 'prompt' }],
    builtin: false,
  };
  try {
    const context = new TestContext();
    createSkillsSubsystem({
      completionRunner: async (prompt) => {
        completionCalls += 1;
        if (prompt.includes('choose the library')) {
          return JSON.stringify(['wayfinder', 'not-a-real-skill', 'wayfinder']);
        }
        assert.match(prompt, /Complete this custom coding-assistant skill definition/);
        return JSON.stringify(draftDef);
      },
    }).register(context);

    const initial = (await command(context, COMMAND_NAMES.skillList)) as {
      skills: readonly SkillDef[];
      adoptions: Readonly<Record<string, readonly string[]>>;
    };
    assert.deepEqual(
      initial.skills.map((skill) => skill.id),
      ['grill-me', 'wayfinder', 'file-gh-issue', 'batch-handle-gh-issues', 'advisor'],
    );
    assert.deepEqual(initial.adoptions, {});

    const custom: SkillDef = {
      id: 'review-context',
      name: 'Review Context',
      body: 'Review {topic} in {style} style for {audience}.',
      params: [
        { name: 'topic', type: 'text', required: true, source: 'prompt' },
        {
          name: 'style',
          type: 'enum',
          required: true,
          options: ['concise', 'detailed'],
          source: 'prompt',
        },
        { name: 'audience', type: 'text', required: true, source: 'agent' },
      ],
      builtin: false,
    };
    const saved = (await command(context, COMMAND_NAMES.skillSave, { def: custom })) as {
      def: SkillDef;
    };
    assert.deepEqual(saved.def, custom);

    const listed = (await command(context, COMMAND_NAMES.skillList)) as {
      skills: readonly SkillDef[];
    };
    assert.equal(listed.skills.at(-1)?.id, 'review-context');

    await assert.rejects(
      command(context, COMMAND_NAMES.skillRemove, { id: 'grill-me' }),
      /built-in/,
    );

    const adoption = await command(context, COMMAND_NAMES.skillAdopt, {
      project: '/tmp/example-project',
      skill_id: 'review-context',
      adopt: true,
    });
    assert.deepEqual(adoption, { adopted: ['review-context'] });
    const afterAdoption = (await command(context, COMMAND_NAMES.skillList)) as {
      adoptions: Readonly<Record<string, readonly string[]>>;
    };
    assert.deepEqual(afterAdoption.adoptions, {
      '/tmp/example-project': ['review-context'],
    });

    const invoked = await command(context, COMMAND_NAMES.skillInvoke, {
      id: 'review-context',
      params: { topic: 'sync retries', style: 'concise' },
    });
    assert.deepEqual(invoked, {
      prompt:
        'Review sync retries in concise style for determine the appropriate audience from context.',
    });
    const builtinInvoked = await command(context, COMMAND_NAMES.skillInvoke, {
      id: 'file-gh-issue',
      params: { mode: 'batch' },
    });
    assert.match((builtinInvoked as { prompt: string }).prompt, /Operating mode: batch/);

    assert.deepEqual(await command(context, COMMAND_NAMES.skillPropose, { project: directory }), {
      proposed: ['wayfinder'],
    });

    const draft = await command(context, COMMAND_NAMES.skillDraft, {
      seed: {
        name: 'Drafted Skill',
        mode: 'conversation',
        conversation: 'Investigate stale data.',
      },
    });
    assert.deepEqual(draft, { def: draftDef });
    assert.equal(completionCalls, 2);
    assert.deepEqual(await command(context, COMMAND_NAMES.skillRemove, { id: 'review-context' }), {
      removed: true,
    });
    const final = (await command(context, COMMAND_NAMES.skillList)) as {
      skills: readonly SkillDef[];
      adoptions: Readonly<Record<string, readonly string[]>>;
    };
    assert.equal(
      final.skills.some((skill) => skill.id === 'review-context'),
      false,
    );
    assert.deepEqual(final.adoptions['/tmp/example-project'], []);
  } finally {
    if (previousPath === undefined) delete process.env.VIBECODIUM_SKILLS_PATH;
    else process.env.VIBECODIUM_SKILLS_PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
