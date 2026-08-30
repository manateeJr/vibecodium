import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_NAMES,
  type FileEntry,
  type FilesDownloadArgs,
  type FilesDownloadResult,
  type FilesListArgs,
  type FilesListResult,
  type FilesSharedDirResult,
  type FilesUploadArgs,
  type FilesUploadResult,
} from '../contracts/commands.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.7z': 'application/x-7z-compressed',
  '.avi': 'video/x-msvideo',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.m4a': 'audio/mp4',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.text': 'text/plain',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
};

export interface FilesSubsystemOptions {
  readonly registryPath?: string;
  readonly sharedDir?: string;
}

interface ScopeRoot {
  readonly path: string;
  readonly realPath?: string;
}

export class FilesSubsystem implements Subsystem {
  public readonly name = 'files';
  private readonly registryPath: string;
  private readonly sharedDir: string;
  private registered = false;

  public constructor(options: FilesSubsystemOptions = {}) {
    this.registryPath =
      options.registryPath ??
      process.env.VIBECODIUM_PROJECTS_PATH ??
      path.join(os.homedir(), '.vibecodium', 'projects.json');
    this.sharedDir =
      options.sharedDir ??
      process.env.VIBECODIUM_SHARED_DIR ??
      path.join(os.homedir(), '.vibecodium', 'shared');
  }

  public register(context: SubsystemContext): void {
    if (this.registered) throw new Error('files subsystem is already registered');
    this.registered = true;
    context.registerCommand(COMMAND_NAMES.filesList, (command: unknown) =>
      this.list(filesListArgs(command)),
    );
    context.registerCommand(COMMAND_NAMES.filesDownload, (command: unknown) =>
      this.download(filesDownloadArgs(command)),
    );
    context.registerCommand(COMMAND_NAMES.filesUpload, (command: unknown) =>
      this.upload(filesUploadArgs(command)),
    );
    context.registerCommand(COMMAND_NAMES.filesSharedDir, () => this.sharedDirectory());
  }

  public async sharedDirectory(): Promise<FilesSharedDirResult> {
    await mkdir(this.sharedDir, { recursive: true });
    const shared = await realpath(this.sharedDir);
    return { path: shared };
  }

  public async list(args: FilesListArgs): Promise<FilesListResult> {
    const roots = await this.scopeRoots();
    if (args.dir === undefined) {
      return {
        entries: roots.map((root) => rootEntry(root.path)),
        scope_roots: roots.map((root) => root.path),
      };
    }

    const directory = await resolveInScope(args.dir, roots);
    const directoryStats = await stat(directory);
    if (!directoryStats.isDirectory()) throw new Error(`path is not a directory: ${args.dir}`);
    const children = await readdir(directory, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = path.join(directory, child.name);
      const safeChildPath = await resolveInScope(childPath, roots);
      const childStats = await stat(safeChildPath);
      entries.push({
        name: child.name,
        path: childPath,
        is_dir: childStats.isDirectory(),
        size: childStats.size,
        mtime: childStats.mtime.toISOString(),
      });
    }
    return {
      entries,
      scope_roots: roots.map((root) => root.path),
    };
  }

  public async download(args: FilesDownloadArgs): Promise<FilesDownloadResult> {
    const roots = await this.scopeRoots();
    const filePath = await resolveInScope(args.path, roots);
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error(`path is not a file: ${args.path}`);
    if (fileStats.size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`download exceeds 500 MB limit: ${args.path}`);
    }
    const content = await readFile(filePath);
    return {
      name: path.basename(path.resolve(args.path)),
      mime: MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      content_base64: content.toString('base64'),
      size: content.byteLength,
    };
  }

  public async upload(args: FilesUploadArgs): Promise<FilesUploadResult> {
    const content = decodeBase64(args.content_base64);
    if (content.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error('upload exceeds 200 MB limit');
    }
    const name = safeUploadName(args.name);
    const sessionId = safeSegment(args.session_id, 'session_id');
    const roots = await this.scopeRoots();
    const sharedRoot = roots.find(
      (root) => path.resolve(root.path) === path.resolve(this.sharedDir),
    );
    if (!sharedRoot) throw new Error('shared directory is not in filesystem scope');
    await mkdir(sharedRoot.path, { recursive: true });
    const targetDirectory = path.join(sharedRoot.path, `session-${sessionId}`);
    await mkdir(targetDirectory, { recursive: true });
    const safeTargetDirectory = await resolveInScope(targetDirectory, roots);
    const targetPath = path.join(safeTargetDirectory, name);
    const safeTargetPath = await resolveUploadPath(targetPath, roots);
    await writeFile(safeTargetPath, content);
    return { path: path.resolve(targetPath), size: content.byteLength };
  }

  private async scopeRoots(): Promise<readonly ScopeRoot[]> {
    const registryPaths = await registeredProjectPaths(this.registryPath);
    const paths = [...registryPaths, path.resolve(this.sharedDir)];
    const roots: ScopeRoot[] = [];
    const seen = new Set<string>();
    for (const rootPath of paths) {
      const absolutePath = path.resolve(rootPath);
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      roots.push({
        path: absolutePath,
        ...(await existingRealPath(absolutePath)),
      });
    }
    return roots;
  }
}

export function createFilesSubsystem(options: FilesSubsystemOptions = {}): FilesSubsystem {
  return new FilesSubsystem(options);
}

async function registeredProjectPaths(registryPath: string): Promise<readonly string[]> {
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
    return record.projects.flatMap((project): string[] => {
      const projectRecord = asRecord(project);
      const projectPath = projectRecord?.path;
      return typeof projectPath === 'string' && projectPath.trim() ? [projectPath] : [];
    });
  } catch {
    return [];
  }
}

async function resolveInScope(input: string, roots: readonly ScopeRoot[]): Promise<string> {
  if (!input || input.includes('\0')) throw new Error('path must be a non-empty string');
  const requestedPath = path.resolve(input);
  const root = roots.find((candidate) => isWithin(requestedPath, candidate.path));
  if (!root) throw new Error(`path is outside allowed filesystem scope: ${input}`);

  let realPath: string;
  try {
    realPath = await realpath(requestedPath);
  } catch {
    throw new Error(`path does not exist: ${input}`);
  }
  const realRoot = root.realPath ?? (await realpath(root.path).catch(() => undefined));
  if (!realRoot || !isWithin(realPath, realRoot)) {
    throw new Error(`path is outside allowed filesystem scope: ${input}`);
  }
  return realPath;
}

async function resolveUploadPath(targetPath: string, roots: readonly ScopeRoot[]): Promise<string> {
  try {
    await lstat(targetPath);
    return resolveInScope(targetPath, roots);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    const parentPath = await resolveInScope(path.dirname(targetPath), roots);
    return path.join(parentPath, path.basename(targetPath));
  }
}

async function existingRealPath(rootPath: string): Promise<{ realPath?: string }> {
  const realPath = await realpath(rootPath).catch(() => undefined);
  return realPath === undefined ? {} : { realPath };
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function rootEntry(rootPath: string): FileEntry {
  return {
    name: path.basename(rootPath),
    path: rootPath,
    is_dir: true,
  };
}

function decodeBase64(value: string): Buffer {
  if (typeof value !== 'string') throw new Error('content_base64 is required');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedSize = Math.floor((value.length * 3) / 4) - padding;
  if (decodedSize > MAX_UPLOAD_BYTES) throw new Error('upload exceeds 200 MB limit');
  return Buffer.from(value, 'base64');
}

function safeUploadName(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error('name must be a non-empty filename');
  }
  const name = path.basename(value.replaceAll('\\', '/'));
  if (!name || name === '.' || name === '..') throw new Error('name must be a filename');
  return name;
}

function safeSegment(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${field} must be a single path segment`);
  }
  return value;
}

function filesListArgs(command: unknown): FilesListArgs {
  const value = asRecord(command);
  if (!value) throw new Error('files.list arguments must be an object');
  if (value.dir !== undefined && typeof value.dir !== 'string') {
    throw new Error('dir must be a string');
  }
  return value.dir === undefined ? {} : { dir: value.dir };
}

function filesDownloadArgs(command: unknown): FilesDownloadArgs {
  const value = asRecord(command);
  if (!value) throw new Error('files.download arguments must be an object');
  if (typeof value.path !== 'string' || !value.path) throw new Error('path is required');
  return { path: value.path };
}

function filesUploadArgs(command: unknown): FilesUploadArgs {
  const value = asRecord(command);
  if (!value) throw new Error('files.upload arguments must be an object');
  if (typeof value.session_id !== 'string' || !value.session_id) {
    throw new Error('session_id is required');
  }
  if (typeof value.name !== 'string' || !value.name) throw new Error('name is required');
  if (typeof value.content_base64 !== 'string') throw new Error('content_base64 is required');
  if (value.mime !== undefined && typeof value.mime !== 'string')
    throw new Error('mime must be a string');
  return {
    session_id: value.session_id,
    name: value.name,
    content_base64: value.content_base64,
    ...(value.mime === undefined ? {} : { mime: value.mime }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
