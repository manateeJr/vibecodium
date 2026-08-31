import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SubstrateSessionRecord } from '../contracts/substrate-contract.js';
import type { SessionTable } from './session-table.js';

export const SESSION_STORAGE_ROOT_ENV = 'VIBECODIUM_SESSION_STORAGE_ROOT';

export function sessionStorageRootFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment[SESSION_STORAGE_ROOT_ENV]?.trim();
  if (configured) return path.resolve(configured);
  const home = environment.HOME?.trim() || os.homedir();
  return path.join(home, '.vibecodium', 'sessions');
}

export function legacySessionStorageRoots(
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const temporary = environment.TMPDIR?.trim() || os.tmpdir();
  const home = environment.HOME?.trim() || os.homedir();
  return uniquePaths([
    path.join(temporary, 'vibecodium-sessions'),
    path.join(home, '.cache', 'vibecodium-sessions'),
  ]);
}

export interface SessionStorageMigrationOptions {
  readonly storageRoot: string;
  readonly oldRoots?: readonly string[];
  readonly now?: () => Date;
  readonly warn?: (message: string) => void;
}

export interface SessionStorageMigrationSummary {
  readonly migrated: number;
  readonly missing: number;
  readonly skipped: number;
}

type PathMatch = {
  readonly root: string;
  readonly candidate: string;
};

type MigrationResult = 'migrated' | 'missing' | 'skipped' | 'unchanged';

export async function migrateSessionStorage(
  table: SessionTable,
  options: SessionStorageMigrationOptions,
): Promise<SessionStorageMigrationSummary> {
  const storageRoot = path.resolve(options.storageRoot);
  const oldRoots = uniquePaths(options.oldRoots ?? legacySessionStorageRoots());
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let migrated = 0;
  let missing = 0;
  let skipped = 0;

  for (const record of table.list()) {
    let result: MigrationResult;
    try {
      result = await migrateRecord(record, table, storageRoot, oldRoots, now);
    } catch (error: unknown) {
      result = 'skipped';
      warn(
        `session storage migration skipped ${record.sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (result === 'migrated') migrated += 1;
    if (result === 'missing') missing += 1;
    if (result === 'skipped') skipped += 1;
  }

  return { migrated, missing, skipped };
}

async function migrateRecord(
  record: SubstrateSessionRecord,
  table: SessionTable,
  storageRoot: string,
  oldRoots: readonly string[],
  now: () => Date,
): Promise<MigrationResult> {
  const storageMatch = matchOldPath(record.storageDir, oldRoots);
  const transcriptMatch = matchOldPath(record.transcriptPath, oldRoots);
  if (!storageMatch && !transcriptMatch) return 'unchanged';

  const sourceDir = storageMatch?.candidate ?? path.dirname(record.transcriptPath);
  const destinationDir = storageMatch
    ? mapPath(storageMatch, storageRoot)
    : path.join(storageRoot, record.sessionId);
  if (sourceDir === destinationDir) return 'unchanged';

  const sourceState = await directoryState(sourceDir);
  if (sourceState === 'missing') {
    if (await isDirectory(destinationDir)) {
      rewriteRecord(table, record, storageRoot, oldRoots, now);
      return 'migrated';
    }
    if (record.state === 'closed') return 'unchanged';
    table.updateState(record.sessionId, 'closed', now().toISOString());
    return 'missing';
  }
  if (sourceState === 'not-directory')
    throw new Error(`old storage path is not a directory: ${sourceDir}`);

  if (await pathExists(destinationDir)) {
    throw new Error(`new storage path already exists: ${destinationDir}`);
  }
  await mkdir(path.dirname(destinationDir), { recursive: true });
  await moveDirectory(sourceDir, destinationDir);
  rewriteRecord(table, record, storageRoot, oldRoots, now);
  return 'migrated';
}

function rewriteRecord(
  table: SessionTable,
  record: SubstrateSessionRecord,
  storageRoot: string,
  oldRoots: readonly string[],
  now: () => Date,
): void {
  const storageMatch = matchOldPath(record.storageDir, oldRoots);
  const transcriptMatch = matchOldPath(record.transcriptPath, oldRoots);
  const storageDir = storageMatch ? mapPath(storageMatch, storageRoot) : record.storageDir;
  const transcriptPath = transcriptMatch
    ? mapPath(transcriptMatch, storageRoot)
    : record.transcriptPath;
  if (storageDir === record.storageDir && transcriptPath === record.transcriptPath) return;
  table.upsert({
    ...record,
    storageDir,
    transcriptPath,
    updatedAt: now().toISOString(),
  });
}

function matchOldPath(candidate: string, oldRoots: readonly string[]): PathMatch | undefined {
  const absoluteCandidate = path.resolve(candidate);
  for (const root of oldRoots) {
    const absoluteRoot = path.resolve(root);
    if (isDescendant(absoluteRoot, absoluteCandidate)) {
      return { root: absoluteRoot, candidate: absoluteCandidate };
    }
  }
  return undefined;
}

function mapPath(match: PathMatch, storageRoot: string): string {
  return path.join(storageRoot, path.relative(match.root, match.candidate));
}

function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function directoryState(
  directory: string,
): Promise<'directory' | 'not-directory' | 'missing'> {
  try {
    return (await stat(directory)).isDirectory() ? 'directory' : 'not-directory';
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    await rm(source, { recursive: true, force: false });
  }
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}
