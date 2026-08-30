import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_NAMES,
  type SkillAdoptArgs,
  type SkillAdoptResult,
  type SkillDef,
  type SkillDraftArgs,
  type SkillDraftResult,
  type SkillInvokeArgs,
  type SkillInvokeResult,
  type SkillProposeArgs,
  type SkillProposeResult,
  type SkillRemoveArgs,
  type SkillRemoveResult,
  type SkillSaveArgs,
  type SkillSaveResult,
} from '../contracts/commands.js';
import type { ProviderSessionRef } from '../contracts/provider-contract.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { providerByName } from '../provider/provider.js';
import { BUILTIN_SKILLS } from './builtins.js';
import {
  extractJsonValue,
  nextSkillId,
  parseSkillDef,
  readSkillStorage,
  skillAdoptArgs,
  skillDraftArgs,
  skillInvokeArgs,
  skillProposeArgs,
  skillRemoveArgs,
  skillSaveArgs,
  validateParameterValue,
  writeSkillStorage,
} from './helpers.js';

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_-]*)\}/g;

export type SkillCompletionRunner = (prompt: string, cwd?: string) => Promise<string | SkillDef>;

export interface SkillsSubsystemOptions {
  readonly skillsPath?: string;
  readonly registryPath?: string;
  readonly completionRunner?: SkillCompletionRunner;
}

export class SkillsSubsystem implements Subsystem {
  public readonly name = 'skills';
  private readonly skillsPath: string;
  private readonly completionRunner: SkillCompletionRunner;

  public constructor(options: SkillsSubsystemOptions = {}) {
    this.skillsPath =
      options.skillsPath ??
      options.registryPath ??
      process.env.VIBECODIUM_SKILLS_PATH ??
      path.join(os.homedir(), '.vibecodium', 'skills.json');
    this.completionRunner = options.completionRunner ?? defaultCompletionRunner;
  }

  public register(context: SubsystemContext): void {
    context.registerCommand(COMMAND_NAMES.skillList, async () => {
      const storage = await readSkillStorage(this.skillsPath);
      return {
        skills: [...BUILTIN_SKILLS, ...storage.custom],
        adoptions: storage.adoptions,
      };
    });
    context.registerCommand(COMMAND_NAMES.skillDraft, (command: unknown) =>
      draftSkill(this.completionRunner, skillDraftArgs(command)),
    );
    context.registerCommand(COMMAND_NAMES.skillSave, (command: unknown) =>
      saveSkill(this.skillsPath, skillSaveArgs(command)),
    );
    context.registerCommand(COMMAND_NAMES.skillRemove, (command: unknown) =>
      removeSkill(this.skillsPath, skillRemoveArgs(command)),
    );
    context.registerCommand(COMMAND_NAMES.skillAdopt, (command: unknown) =>
      adoptSkill(this.skillsPath, skillAdoptArgs(command)),
    );
    context.registerCommand(COMMAND_NAMES.skillPropose, (command: unknown) =>
      proposeSkills(this.skillsPath, this.completionRunner, skillProposeArgs(command)),
    );
    context.registerCommand(COMMAND_NAMES.skillInvoke, (command: unknown) =>
      invokeSkill(this.skillsPath, skillInvokeArgs(command)),
    );
  }
}

export function createSkillsSubsystem(options: SkillsSubsystemOptions = {}): SkillsSubsystem {
  return new SkillsSubsystem(options);
}

async function draftSkill(
  completionRunner: SkillCompletionRunner,
  args: SkillDraftArgs,
): Promise<SkillDraftResult> {
  const output = await completionRunner(draftPrompt(args.seed));
  const value = typeof output === 'string' ? extractJsonValue(output) : output;
  const record = asRecord(value);
  if (!record) throw new Error('skill.draft completion must return a JSON object');
  const candidate: Record<string, unknown> = {
    ...record,
    id: record.id ?? nextSkillId(args.seed.name, []),
    name: record.name ?? args.seed.name,
    body: record.body ?? args.seed.body,
    params: record.params ?? args.seed.params ?? [],
    builtin: false,
  };
  return { def: parseSkillDef(candidate, true) };
}

async function saveSkill(skillsPath: string, args: SkillSaveArgs): Promise<SkillSaveResult> {
  const storage = await readSkillStorage(skillsPath);
  if (args.def.builtin || BUILTIN_SKILLS.some((skill) => skill.id === args.def.id)) {
    throw new Error('cannot overwrite a built-in skill');
  }
  const id = args.def.id || nextSkillId(args.def.name, storage.custom);
  const def: SkillDef = { ...args.def, id, builtin: false };
  parseSkillDef(def, false);
  const existingIndex = storage.custom.findIndex((skill) => skill.id === id);
  const custom = [...storage.custom];
  if (existingIndex < 0) custom.push(def);
  else custom[existingIndex] = def;
  await writeSkillStorage(skillsPath, { custom, adoptions: storage.adoptions });
  return { def };
}

async function removeSkill(skillsPath: string, args: SkillRemoveArgs): Promise<SkillRemoveResult> {
  if (BUILTIN_SKILLS.some((skill) => skill.id === args.id)) {
    throw new Error('cannot remove a built-in skill');
  }
  const storage = await readSkillStorage(skillsPath);
  const custom = storage.custom.filter((skill) => skill.id !== args.id);
  if (custom.length === storage.custom.length) return { removed: false };
  const adoptions: Record<string, string[]> = {};
  for (const [project, ids] of Object.entries(storage.adoptions)) {
    adoptions[project] = ids.filter((id) => id !== args.id);
  }
  await writeSkillStorage(skillsPath, { custom, adoptions });
  return { removed: true };
}

async function adoptSkill(skillsPath: string, args: SkillAdoptArgs): Promise<SkillAdoptResult> {
  const storage = await readSkillStorage(skillsPath);
  const known =
    BUILTIN_SKILLS.some((skill) => skill.id === args.skill_id) ||
    storage.custom.some((skill) => skill.id === args.skill_id);
  if (!known) throw new Error(`unknown skill: ${args.skill_id}`);
  const current = storage.adoptions[args.project] ?? [];
  const adopted = args.adopt
    ? current.includes(args.skill_id)
      ? [...current]
      : [...current, args.skill_id]
    : current.filter((id) => id !== args.skill_id);
  const adoptions = { ...storage.adoptions, [args.project]: adopted };
  await writeSkillStorage(skillsPath, { custom: storage.custom, adoptions });
  return { adopted };
}

async function proposeSkills(
  skillsPath: string,
  completionRunner: SkillCompletionRunner,
  args: SkillProposeArgs,
): Promise<SkillProposeResult> {
  const storage = await readSkillStorage(skillsPath);
  const library = [...BUILTIN_SKILLS, ...storage.custom];
  try {
    const output = await completionRunner(proposalPrompt(args.project, library), args.project);
    return { proposed: parseProposedSkills(output, new Set(library.map((skill) => skill.id))) };
  } catch {
    return { proposed: [] };
  }
}

async function invokeSkill(skillsPath: string, args: SkillInvokeArgs): Promise<SkillInvokeResult> {
  const storage = await readSkillStorage(skillsPath);
  const skill = [...BUILTIN_SKILLS, ...storage.custom].find((entry) => entry.id === args.id);
  if (!skill) throw new Error(`unknown skill: ${args.id}`);
  const params = new Map(skill.params.map((param) => [param.name, param]));
  for (const name of Object.keys(args.params)) {
    if (!params.has(name)) throw new Error(`unknown parameter: ${name}`);
  }
  const values = new Map<string, string>();
  for (const param of skill.params) {
    const value = args.params[param.name];
    if (value !== undefined) {
      validateParameterValue(param, value);
      values.set(param.name, value);
    } else if (param.source === 'agent') {
      values.set(param.name, `determine the appropriate ${param.name} from context`);
    } else if (param.default !== undefined) {
      values.set(param.name, param.default);
    } else if (param.required) {
      throw new Error(`missing required parameter: ${param.name}`);
    } else {
      values.set(param.name, '');
    }
  }
  return {
    prompt: skill.body.replace(
      PLACEHOLDER_PATTERN,
      (_placeholder, name: string) => values.get(name) ?? '',
    ),
  };
}

async function defaultCompletionRunner(prompt: string, cwd?: string): Promise<string> {
  const provider: ProviderSessionRef = providerByName('omp');
  const session = await provider.spawn({
    sessionId: randomUUID(),
    prompt,
    ...(cwd === undefined ? {} : { cwd }),
  });
  try {
    let output = '';
    for await (const chunk of provider.stream(session)) output += chunk.text;
    return output;
  } finally {
    await provider.stop(session);
  }
}

function draftPrompt(seed: SkillDraftArgs['seed']): string {
  const serializedSeed = JSON.stringify({
    name: seed.name,
    mode: seed.mode,
    ...(seed.body === undefined ? {} : { body: seed.body }),
    ...(seed.params === undefined ? {} : { params: seed.params }),
    ...(seed.conversation === undefined ? {} : { conversation: seed.conversation }),
  });
  return [
    'Complete this custom coding-assistant skill definition.',
    'Turn the seed into a polished, concrete prompt body that works in a repository session.',
    'Return ONLY one JSON object with id, name, optional description, body, params, optional approval, and builtin:false.',
    'Each param must have name, type (text|enum|bool), required, optional default, optional enum options, and source (prompt|agent).',
    'Use {paramName} placeholders in body only for declared params, and include every declared param in the body.',
    'Do not create a built-in or a production-publishing skill.',
    `Seed: ${serializedSeed}`,
  ].join(' ');
}

function proposalPrompt(project: string, skills: readonly SkillDef[]): string {
  const library = skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description ?? '',
  }));
  return [
    'Inspect the repository at the supplied working directory and choose the library skills that best fit it.',
    'Return ONLY a JSON array of skill ids, in descending usefulness order, with no markdown or prose.',
    'Choose zero or more ids from this library and do not invent ids.',
    `Project: ${project}`,
    `Library: ${JSON.stringify(library)}`,
  ].join(' ');
}

function parseProposedSkills(
  output: string | SkillDef,
  availableIds: ReadonlySet<string>,
): readonly string[] {
  const value = typeof output === 'string' ? extractJsonValue(output) : output;
  const record = asRecord(value);
  const entries = Array.isArray(value)
    ? value
    : record && Array.isArray(record.proposed)
      ? record.proposed
      : [];
  const proposed: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (availableIds.has(id) && !proposed.includes(id)) proposed.push(id);
  }
  return proposed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
