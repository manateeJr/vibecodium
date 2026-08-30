import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type SkillAdoptArgs,
  type SkillDef,
  type SkillDraftArgs,
  type SkillInvokeArgs,
  type SkillParam,
  type SkillProposeArgs,
  type SkillRemoveArgs,
  type SkillSaveArgs,
} from '../contracts/commands.js';
import { BUILTIN_SKILLS } from './builtins.js';

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_-]*)\}/g;

export interface SkillStorage {
  custom: SkillDef[];
  adoptions: Record<string, string[]>;
}

export function skillDraftArgs(command: unknown): SkillDraftArgs {
  const value = asRecord(command);
  const seed = value && asRecord(value.seed);
  if (!seed || !nonEmptyString(seed.name)) throw new Error('seed.name is required');
  if (seed.body !== undefined && typeof seed.body !== 'string') {
    throw new Error('seed.body must be a string');
  }
  if (seed.mode !== 'form' && seed.mode !== 'conversation') {
    throw new Error('seed.mode must be form or conversation');
  }
  if (seed.conversation !== undefined && typeof seed.conversation !== 'string') {
    throw new Error('seed.conversation must be a string');
  }
  if (seed.mode === 'conversation' && !nonEmptyString(seed.conversation)) {
    throw new Error('seed.conversation is required in conversation mode');
  }
  if (seed.params !== undefined && !Array.isArray(seed.params)) {
    throw new Error('seed.params must be an array');
  }
  const params = seed.params?.map((param) => parseSkillParam(param));
  return {
    seed: {
      name: seed.name.trim(),
      mode: seed.mode,
      ...(seed.body === undefined ? {} : { body: seed.body }),
      ...(params === undefined ? {} : { params }),
      ...(seed.conversation === undefined ? {} : { conversation: seed.conversation }),
    },
  };
}

export function skillSaveArgs(command: unknown): SkillSaveArgs {
  const value = asRecord(command);
  if (!value || !('def' in value)) throw new Error('def is required');
  return { def: parseSkillDef(value.def, true) };
}

export function skillRemoveArgs(command: unknown): SkillRemoveArgs {
  const value = asRecord(command);
  if (!value || !nonEmptyString(value.id)) throw new Error('id is required');
  return { id: value.id.trim() };
}

export function skillAdoptArgs(command: unknown): SkillAdoptArgs {
  const value = asRecord(command);
  if (!value || !nonEmptyString(value.project)) throw new Error('project is required');
  if (!value || !nonEmptyString(value.skill_id)) throw new Error('skill_id is required');
  if (!value || typeof value.adopt !== 'boolean') throw new Error('adopt must be a boolean');
  return {
    project: value.project.trim(),
    skill_id: value.skill_id.trim(),
    adopt: value.adopt,
  };
}

export function skillProposeArgs(command: unknown): SkillProposeArgs {
  const value = asRecord(command);
  if (!value || !nonEmptyString(value.project)) throw new Error('project is required');
  return { project: value.project.trim() };
}

export function skillInvokeArgs(command: unknown): SkillInvokeArgs {
  const value = asRecord(command);
  if (!value || !nonEmptyString(value.id)) throw new Error('id is required');
  const paramsRecord = asRecord(value.params);
  if (!paramsRecord) throw new Error('params must be an object');
  const params: Record<string, string> = {};
  for (const [name, parameter] of Object.entries(paramsRecord)) {
    if (typeof parameter !== 'string') throw new Error(`parameter ${name} must be a string`);
    params[name] = parameter;
  }
  return { id: value.id.trim(), params };
}

export function parseSkillDef(value: unknown, allowEmptyId: boolean): SkillDef {
  const record = asRecord(value);
  if (!record) throw new Error('skill definition must be an object');
  if (record.id !== undefined && typeof record.id !== 'string') {
    throw new Error('skill id must be a string');
  }
  const id = record.id === undefined ? '' : record.id.trim();
  if (!allowEmptyId && !id) throw new Error('skill id is required');
  if (!nonEmptyString(record.name)) throw new Error('skill name is required');
  if (typeof record.body !== 'string' || !record.body.trim()) {
    throw new Error('skill body is required');
  }
  if (record.params !== undefined && !Array.isArray(record.params)) {
    throw new Error('skill params must be an array');
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new Error('skill description must be a string');
  }
  const approvalValue =
    typeof record.approval === 'boolean'
      ? record.approval
      : typeof record.approval === 'string'
        ? record.approval.trim().toLowerCase() === 'true'
        : undefined;
  if (record.builtin !== undefined && typeof record.builtin !== 'boolean') {
    throw new Error('skill builtin must be a boolean');
  }
  const params = (record.params ?? []).map((param) => parseSkillParam(param));
  const def: SkillDef = {
    id,
    name: record.name.trim(),
    body: record.body,
    params,
    builtin: record.builtin === true,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(approvalValue === undefined ? {} : { approval: approvalValue }),
  };
  validateSkillDef(def, allowEmptyId);
  return def;
}

export function parseSkillParam(value: unknown): SkillParam {
  const record = asRecord(value);
  if (!record || !nonEmptyString(record.name)) throw new Error('skill parameter name is required');
  if (record.type !== 'text' && record.type !== 'enum' && record.type !== 'bool') {
    throw new Error(`invalid skill parameter type: ${String(record.type)}`);
  }
  if (typeof record.required !== 'boolean')
    throw new Error('skill parameter required must be boolean');
  if (record.default !== undefined && typeof record.default !== 'string') {
    throw new Error('skill parameter default must be a string');
  }
  if (record.source !== 'prompt' && record.source !== 'agent') {
    throw new Error('skill parameter source must be prompt or agent');
  }
  if (record.options !== undefined && !Array.isArray(record.options)) {
    throw new Error('skill parameter options must be an array');
  }
  const options = record.options?.map((option) => {
    if (typeof option !== 'string' || !option.trim())
      throw new Error('skill enum options must be strings');
    return option;
  });
  const param: SkillParam = {
    name: record.name.trim(),
    type: record.type,
    required: record.required,
    source: record.source,
    ...(record.default === undefined ? {} : { default: record.default }),
    ...(options === undefined ? {} : { options }),
  };
  validateSkillParam(param);
  return param;
}

export function validateSkillDef(def: SkillDef, allowEmptyId = false): void {
  if (!allowEmptyId && !nonEmptyString(def.id)) throw new Error('skill id is required');
  if (!nonEmptyString(def.name)) throw new Error('skill name is required');
  if (!def.body.trim()) throw new Error('skill body is required');
  const params = new Map<string, SkillParam>();
  for (const param of def.params) {
    validateSkillParam(param);
    if (params.has(param.name)) throw new Error(`duplicate skill parameter: ${param.name}`);
    params.set(param.name, param);
  }
  const placeholders = new Set<string>();
  for (const match of def.body.matchAll(PLACEHOLDER_PATTERN)) placeholders.add(match[1]!);
  for (const placeholder of placeholders) {
    if (!params.has(placeholder)) throw new Error(`unknown skill placeholder: ${placeholder}`);
  }
}

export function validateParameterValue(param: SkillParam, value: string): void {
  if (param.type === 'enum' && !param.options?.includes(value)) {
    throw new Error(`invalid value for ${param.name}: ${value}`);
  }
  if (param.type === 'bool' && value !== 'true' && value !== 'false') {
    throw new Error(`boolean parameter must be true or false: ${param.name}`);
  }
}

function validateSkillParam(param: SkillParam): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(param.name)) {
    throw new Error(`invalid skill parameter name: ${param.name}`);
  }
  if (param.type === 'enum') {
    if (!param.options || param.options.length === 0) {
      throw new Error(`enum parameter requires options: ${param.name}`);
    }
    if (new Set(param.options).size !== param.options.length) {
      throw new Error(`enum options must be unique: ${param.name}`);
    }
    if (param.default !== undefined && !param.options.includes(param.default)) {
      throw new Error(`enum default is not an option: ${param.name}`);
    }
  } else if (param.type === 'bool') {
    if (param.options !== undefined)
      throw new Error(`bool parameter cannot have options: ${param.name}`);
    if (param.default !== undefined && param.default !== 'true' && param.default !== 'false') {
      throw new Error(`bool default must be true or false: ${param.name}`);
    }
  } else if (param.options !== undefined) {
    throw new Error(`text parameter cannot have options: ${param.name}`);
  }
}

export function nextSkillId(name: string, custom: readonly SkillDef[]): string {
  const base = slugify(name) || 'skill';
  const used = new Set([...BUILTIN_SKILLS, ...custom].map((skill) => skill.id));
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  return id;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function readSkillStorage(skillsPath: string): Promise<SkillStorage> {
  let text: string;
  try {
    text = await readFile(skillsPath, 'utf8');
  } catch {
    return { custom: [], adoptions: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { custom: [], adoptions: {} };
  }
  const record = asRecord(parsed);
  if (!record) return { custom: [], adoptions: {} };
  const builtinIds = new Set(BUILTIN_SKILLS.map((skill) => skill.id));
  const custom = Array.isArray(record.custom)
    ? record.custom.flatMap((value) => {
        try {
          const skill = parseSkillDef(value, false);
          return skill.builtin || builtinIds.has(skill.id) ? [] : [skill];
        } catch {
          return [];
        }
      })
    : [];
  const adoptions: Record<string, string[]> = {};
  const rawAdoptions = asRecord(record.adoptions);
  if (rawAdoptions) {
    for (const [project, ids] of Object.entries(rawAdoptions)) {
      if (!Array.isArray(ids)) continue;
      adoptions[project] = [
        ...new Set(
          ids
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => id.trim()),
        ),
      ];
    }
  }
  return { custom, adoptions };
}

export async function writeSkillStorage(skillsPath: string, storage: SkillStorage): Promise<void> {
  await mkdir(path.dirname(skillsPath), { recursive: true });
  const temporaryPath = `${skillsPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(storage, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, skillsPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function extractJsonValue(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Search below for a JSON object or array surrounded by provider prose.
  }
  const candidates: Array<{ start: number; open: string; close: string }> = [];
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    for (let start = output.indexOf(open); start >= 0; start = output.indexOf(open, start + 1)) {
      candidates.push({ start, open, close });
    }
  }
  candidates.sort((left, right) => left.start - right.start);
  for (const candidate of candidates) {
    const end = matchingEnd(output, candidate.start, candidate.open, candidate.close);
    if (end < 0) continue;
    try {
      return JSON.parse(output.slice(candidate.start, end + 1)) as unknown;
    } catch {
      // Continue searching after prose or malformed JSON.
    }
  }
  throw new Error('agent output did not contain valid JSON');
}

function matchingEnd(value: string, start: number, open: string, close: string): number {
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
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
