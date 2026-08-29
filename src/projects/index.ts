import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_NAMES,
  type Project,
  type ProjectDetectArgs,
  type ProjectDetectResult,
  type ProjectRemoveArgs,
  type ProjectRemoveResult,
  type ProjectSaveArgs,
  type ProjectSaveResult,
  type QuickAction,
} from '../contracts/commands.js';
import type { ProviderSessionRef } from '../contracts/provider-contract.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { providerByName } from '../provider/provider.js';

export interface DetectInput {
  readonly path: string;
  readonly description?: string;
}

export type DetectRunner = (input: DetectInput) => Promise<string>;

export interface ProjectsSubsystemOptions {
  readonly registryPath?: string;
  readonly detect?: DetectRunner;
}

export function createProjectsSubsystem(options: ProjectsSubsystemOptions = {}): Subsystem {
  const registryPath =
    options.registryPath ??
    process.env.VIBECODIUM_PROJECTS_PATH ??
    path.join(os.homedir(), '.vibecodium', 'projects.json');
  const detect = options.detect ?? defaultDetect;

  return {
    name: 'projects',
    register(context: SubsystemContext): void {
      context.registerCommand(COMMAND_NAMES.projectList, async () => ({
        projects: await readProjects(registryPath),
      }));
      context.registerCommand(COMMAND_NAMES.projectSave, (command: unknown) =>
        saveProject(registryPath, projectSaveArgs(command)),
      );
      context.registerCommand(COMMAND_NAMES.projectRemove, (command: unknown) =>
        removeProject(registryPath, projectRemoveArgs(command)),
      );
      context.registerCommand(COMMAND_NAMES.projectDetect, (command: unknown) =>
        detectProject(detect, projectDetectArgs(command)),
      );
    },
  };
}

async function saveProject(
  registryPath: string,
  args: ProjectSaveArgs,
): Promise<ProjectSaveResult> {
  const projects = await readProjects(registryPath);
  const project: Project = {
    name: args.name,
    path: args.path,
    description: args.description,
    quickActions: args.quickActions,
    scope: 'project',
  };
  const existingIndex = projects.findIndex((entry) => entry.name === project.name);
  const nextProjects = [...projects];
  if (existingIndex < 0) nextProjects.push(project);
  else nextProjects[existingIndex] = project;
  await writeProjects(registryPath, nextProjects);
  return { project };
}

async function removeProject(
  registryPath: string,
  args: ProjectRemoveArgs,
): Promise<ProjectRemoveResult> {
  const projects = await readProjects(registryPath);
  const nextProjects = projects.filter((project) => project.name !== args.name);
  if (nextProjects.length === projects.length) return { removed: false };
  await writeProjects(registryPath, nextProjects);
  return { removed: true };
}

async function detectProject(
  detect: DetectRunner,
  args: ProjectDetectArgs,
): Promise<ProjectDetectResult> {
  try {
    return { proposed: parseDetectedActions(await detect(args)) };
  } catch {
    return { proposed: [] };
  }
}

async function defaultDetect(input: DetectInput): Promise<string> {
  const provider: ProviderSessionRef = providerByName('omp');
  const session = await provider.spawn({
    sessionId: randomUUID(),
    prompt: detectionPrompt(input),
    cwd: input.path,
  });
  try {
    let output = '';
    for await (const chunk of provider.stream(session)) output += chunk.text;
    return output;
  } finally {
    await provider.stop(session);
  }
}

function detectionPrompt(input: DetectInput): string {
  const description = input.description?.trim();
  return [
    'You are in a project working directory. Inspect this repository and propose the most useful quick actions for this project.',
    'Output ONLY a JSON array of up to 6 objects.',
    'Each object must have a label of at most 4 words and a prompt that invokes the most useful skill or action for THIS repo.',
    'Do not include markdown fences or surrounding prose.',
    ...(description ? [`Project description: ${description}`] : []),
  ].join(' ');
}

function parseDetectedActions(output: string): readonly QuickAction[] {
  const value = extractJsonArray(output);
  if (!value) return [];
  const usedIds = new Map<string, number>();
  const actions: QuickAction[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || typeof record.label !== 'string' || typeof record.prompt !== 'string') continue;
    const label = record.label.trim();
    const prompt = record.prompt.trim();
    if (!label || !prompt) continue;
    const baseId = slugify(label) || `action-${actions.length + 1}`;
    const count = usedIds.get(baseId) ?? 0;
    usedIds.set(baseId, count + 1);
    actions.push({
      id: count === 0 ? baseId : `${baseId}-${count + 1}`,
      label,
      prompt,
    });
    if (actions.length === 6) break;
  }
  return actions;
}

function extractJsonArray(output: string): readonly unknown[] | undefined {
  for (let start = output.indexOf('['); start >= 0; start = output.indexOf('[', start + 1)) {
    const end = matchingArrayEnd(output, start);
    if (end < 0) continue;
    try {
      const parsed: unknown = JSON.parse(output.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Continue searching for the next array after prose or malformed JSON.
    }
  }
  return undefined;
}

function matchingArrayEnd(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function readProjects(registryPath: string): Promise<readonly Project[]> {
  let text: string;
  try {
    text = await readFile(registryPath, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const record = asRecord(parsed);
    if (!record || !Array.isArray(record.projects)) return [];
    return record.projects.flatMap((entry) => {
      const project = parseProject(entry);
      return project ? [project] : [];
    });
  } catch {
    return [];
  }
}

async function writeProjects(registryPath: string, projects: readonly Project[]): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ projects }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, registryPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function projectSaveArgs(command: unknown): ProjectSaveArgs {
  const value = asRecord(command);
  if (!value || !nonEmptyString(value.name)) throw new Error('name is required');
  if (!value || !nonEmptyString(value.path)) throw new Error('path is required');
  if (!value || typeof value.description !== 'string') throw new Error('description is required');
  if (!value || !Array.isArray(value.quickActions))
    throw new Error('quickActions must be an array');
  return {
    name: value.name,
    path: value.path,
    description: value.description,
    quickActions: value.quickActions.map((action) => quickActionArgs(action)),
  };
}

function projectRemoveArgs(command: unknown): ProjectRemoveArgs {
  const value = asRecord(command);
  if (!value || !nonEmptyString(value.name)) throw new Error('name is required');
  return { name: value.name };
}

function projectDetectArgs(command: unknown): ProjectDetectArgs {
  const value = asRecord(command);
  if (!value || !nonEmptyString(value.path)) throw new Error('path is required');
  if (value.description !== undefined && typeof value.description !== 'string')
    throw new Error('description must be a string');
  return {
    path: value.path,
    ...(value.description === undefined ? {} : { description: value.description }),
  };
}

function quickActionArgs(value: unknown): QuickAction {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.label !== 'string' ||
    typeof record.prompt !== 'string'
  ) {
    throw new Error('quick action must include id, label, and prompt');
  }
  return { id: record.id, label: record.label, prompt: record.prompt };
}

function parseProject(value: unknown): Project | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !nonEmptyString(record.name) ||
    !nonEmptyString(record.path) ||
    typeof record.description !== 'string' ||
    record.scope !== 'project' ||
    !Array.isArray(record.quickActions)
  ) {
    return undefined;
  }
  try {
    return {
      name: record.name,
      path: record.path,
      description: record.description,
      quickActions: record.quickActions.map((action) => quickActionArgs(action)),
      scope: 'project',
    };
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
