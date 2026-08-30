import { open as openFile, readdir, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_NAMES,
  type MachineListResult,
  type MachineSessionSummary,
} from '../contracts/commands.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';

const SESSION_PREFIX_BYTES = 256 * 1024;
const SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface MachineSessionsSubsystemOptions {
  readonly ompRoot?: string;
  readonly codexRoot?: string;
  readonly now?: () => Date;
}
export interface ResolvedMachineSession extends MachineSessionSummary {
  readonly path: string;
}

export interface MachineSessionResolver {
  resolve(ref: string): Promise<ResolvedMachineSession | undefined>;
}

interface ParsedMetadata {
  readonly valid: boolean;
  readonly title?: string;
  readonly cwd?: string;
  readonly userText?: string;
  readonly kind: MachineSessionSummary['kind'];
}

export class MachineSessionsSubsystem implements Subsystem, MachineSessionResolver {
  public readonly name = 'machine-sessions';
  private readonly ompRoot: string;
  private readonly codexRoot: string;
  private readonly now: () => Date;

  public constructor(options: MachineSessionsSubsystemOptions = {}) {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.omp', 'agent');
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    this.ompRoot = options.ompRoot ?? path.join(agentDir, 'sessions');
    this.codexRoot = options.codexRoot ?? path.join(codexHome, 'sessions');
    this.now = options.now ?? (() => new Date());
  }

  public register(context: SubsystemContext): void {
    context.registerCommand(COMMAND_NAMES.machineList, () => this.list());
  }

  public async list(): Promise<MachineListResult> {
    const [omp, codex] = await Promise.all([
      readStore('omp', this.ompRoot, this.now),
      readStore('codex', this.codexRoot, this.now),
    ]);
    const counts: Record<MachineSessionSummary['source'], number> = { omp: 0, codex: 0 };
    const sessions = [...omp, ...codex]
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
      .filter((session) => {
        if (counts[session.source] >= 100) return false;
        counts[session.source] += 1;
        return true;
      })
      .map((session) => ({
        source: session.source,
        ref: session.ref,
        title: session.title,
        cwd: session.cwd,
        updated_at: session.updated_at,
        kind: session.kind,
      }));
    return { sessions };
  }

  public async resolve(ref: string): Promise<ResolvedMachineSession | undefined> {
    const parsed = parseMachineRef(ref);
    const sources: readonly MachineSessionSummary['source'][] = parsed
      ? [parsed.source]
      : ['omp', 'codex'];
    for (const source of sources) {
      const root = source === 'omp' ? this.ompRoot : this.codexRoot;
      const sessions = await readStore(source, root, this.now);
      const match = sessions.find((session) => session.ref === (parsed?.ref ?? ref));
      if (match) return match;
    }
    return undefined;
  }
}

export function createMachineSessionsSubsystem(
  options: MachineSessionsSubsystemOptions = {},
): MachineSessionsSubsystem {
  return new MachineSessionsSubsystem(options);
}

async function readStore(
  source: MachineSessionSummary['source'],
  root: string,
  now: () => Date,
): Promise<ResolvedMachineSession[]> {
  const files: string[] = [];
  await collectJsonlFiles(root, files);
  const summaries = await Promise.all(files.map((file) => readSummary(source, file, now)));
  return summaries.filter((summary): summary is ResolvedMachineSession => summary !== undefined);
}

async function collectJsonlFiles(directory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectJsonlFiles(file, files);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(file);
      }
    }),
  );
}

async function readSummary(
  source: MachineSessionSummary['source'],
  file: string,
  now: () => Date,
): Promise<ResolvedMachineSession | undefined> {
  let modified: number;
  try {
    modified = (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
  const metadata = await readMetadata(file);
  if (!metadata.valid) return undefined;
  const parent = path.basename(path.dirname(file));
  const ref = sessionRef(source, file);
  if (!ref) return undefined;
  const title = (metadata.title ?? metadata.userText ?? parent).trim() || parent;
  const cwd = (metadata.cwd ?? decodeDirectoryLabel(parent)).trim() || decodeDirectoryLabel(parent);
  const updated = Number.isFinite(modified) ? new Date(modified) : now();
  return {
    source,
    ref,
    title,
    cwd,
    kind: metadata.kind,
    updated_at: updated.toISOString(),
    path: file,
  };
}

async function readMetadata(file: string): Promise<ParsedMetadata> {
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(file, 'r');
    const buffer = Buffer.alloc(SESSION_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    let valid = false;
    let title: string | undefined;
    let cwd: string | undefined;
    let userText: string | undefined;
    let kind: MachineSessionSummary['kind'] = 'main';
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      valid = true;
      title ??= findStringField(value, 'title');
      cwd ??= findStringField(value, 'cwd');
      userText ??= findUserText(value);
      if (value.type === 'session_init' && typeof value.agent === 'string' && value.agent.trim()) {
        kind = 'subagent';
      }
    }
    return {
      valid,
      kind,
      ...(title === undefined ? {} : { title }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(userText === undefined ? {} : { userText }),
    };
  } catch {
    return { valid: false, kind: 'main' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseMachineRef(
  ref: string,
): { source: MachineSessionSummary['source']; ref: string } | undefined {
  const match = ref.match(/^machine:(omp|codex):(.+)$/);
  return match?.[1] && match[2]
    ? { source: match[1] as MachineSessionSummary['source'], ref: match[2] }
    : undefined;
}
function sessionRef(source: MachineSessionSummary['source'], file: string): string | undefined {
  const stem = path.basename(file, '.jsonl');
  const parent = path.basename(path.dirname(file));
  for (const candidate of [stem, parent]) {
    const uuid = candidate.match(SESSION_ID_RE)?.[1];
    if (uuid) return uuid;
    if (source === 'omp') {
      const separator = candidate.lastIndexOf('_');
      if (separator >= 0 && separator < candidate.length - 1) return candidate.slice(separator + 1);
      if (candidate && candidate !== 'session') return candidate;
    }
    if (source === 'codex') {
      const rollout = candidate.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/);
      if (rollout?.[1]) return rollout[1];
      const separator = candidate.lastIndexOf('_');
      if (separator >= 0 && separator < candidate.length - 1) return candidate.slice(separator + 1);
      if (candidate && !candidate.startsWith('rollout-') && candidate !== 'session')
        return candidate;
    }
  }
  return undefined;
}

function findStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value[key];
  if (typeof direct === 'string' && direct.trim()) return direct;
  for (const nested of Object.values(value)) {
    const found = findStringField(nested, key);
    if (found) return found;
  }
  return undefined;
}

function findUserText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.role === 'user') {
    const text =
      textFromContent(value.content) ?? (typeof value.text === 'string' ? value.text : undefined);
    if (text?.trim()) return text;
  }
  for (const nested of Object.values(value)) {
    const found = findUserText(nested);
    if (found) return found;
  }
  return undefined;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .map(textFromContent)
      .filter((part): part is string => part !== undefined)
      .join('');
    return text || undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.text === 'string') return value.text;
  return textFromContent(value.content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeDirectoryLabel(label: string): string {
  if (label.startsWith('--') && label.endsWith('--')) {
    return `/${label.slice(2, -2).replaceAll('-', '/')}`;
  }
  if (label.startsWith('-')) {
    const components = label.slice(1).split('-').filter(Boolean);
    return components.length > 0 ? path.join(os.homedir(), ...components) : os.homedir();
  }
  return label;
}
