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
