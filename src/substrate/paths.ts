import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
export interface SocketPathOptions {
  readonly socketDir?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function userName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? String(process.getuid?.() ?? 'user');
  }
}

const ABDUCO_SUN_PATH_BYTES = 108;
const WORST_CASE_SUBSTRATE_NAME = `substrate-${'0'.repeat(36)}`;

export function planeSocketDir(
  dataPath: string,
  environment?: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const env = environment ?? process.env;
  if (env.ABDUCO_SOCKET_DIR?.length) return undefined;
  if (!dataPath || dataPath === ':memory:') return undefined;

  const id = createHash('sha1').update(path.resolve(dataPath)).digest('hex').slice(0, 8);
  const candidateBases = [
    env.XDG_RUNTIME_DIR?.length ? env.XDG_RUNTIME_DIR : undefined,
    env.TMPDIR?.length ? env.TMPDIR : undefined,
    os.tmpdir(),
  ].filter((base): base is string => base !== undefined);
  for (const base of [...new Set(candidateBases)]) {
    const socketDir = path.join(base, `vc-${id}`);
    const socketPath = socketPathCandidates(WORST_CASE_SUBSTRATE_NAME, { socketDir })[0];
    if (socketPath !== undefined && Buffer.byteLength(socketPath) < ABDUCO_SUN_PATH_BYTES)
      return socketDir;
  }
  return undefined;
}

export function validateSessionName(name: string): void {
  if (name.length === 0 || name.includes('/') || name.includes('\0'))
    throw new Error('abduco session names must be non-empty and may not contain / or NUL');
}

export function socketPathCandidates(
  name: string,
  options: SocketPathOptions = {},
): readonly string[] {
  validateSessionName(name);
  const environment = options.environment ?? process.env;
  const configuredDirectory = options.socketDir ?? environment.ABDUCO_SOCKET_DIR;
  const sessionFile = `${name}@${os.hostname()}`;
  if (configuredDirectory)
    return [path.join(configuredDirectory, 'abduco', userName(), sessionFile)];

  const home = environment.HOME ?? os.homedir();
  const temporary = environment.TMPDIR ?? os.tmpdir();
  const candidates = [
    path.join(home, '.abduco', sessionFile),
    path.join(temporary, 'abduco', userName(), sessionFile),
    path.join('/tmp', 'abduco', userName(), sessionFile),
  ];
  return [...new Set(candidates)];
}

export function abducoBinaryPath(): string {
  return path.resolve(repositoryRoot(), '.vibecodium', 'bin', 'abduco');
}

function repositoryRoot(): string {
  return (
    findRepositoryRoot(process.cwd()) ??
    findRepositoryRoot(path.dirname(fileURLToPath(import.meta.url))) ??
    process.cwd()
  );
}

function findRepositoryRoot(start: string): string | undefined {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
