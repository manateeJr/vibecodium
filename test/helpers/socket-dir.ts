import fs from 'node:fs';
import path from 'node:path';

export interface TestSocketDir {
  readonly socketDir: string;
  dispose(): void;
}

export function createTestSocketDir(): TestSocketDir {
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'vc-test-'));
  const previous = process.env.ABDUCO_SOCKET_DIR;
  process.env.ABDUCO_SOCKET_DIR = socketDir;
  let disposed = false;
  return {
    socketDir,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (previous === undefined) delete process.env.ABDUCO_SOCKET_DIR;
      else process.env.ABDUCO_SOCKET_DIR = previous;
      fs.rmSync(socketDir, { recursive: true, force: true });
    },
  };
}
