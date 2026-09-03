import fs from 'node:fs';
import path from 'node:path';
import { socketPathCandidates } from './paths.js';

export function cleanupDerivedSocketDir(socketDir: string): void {
  const socketPath = socketPathCandidates('substrate-cleanup', { socketDir })[0];
  if (socketPath === undefined) return;
  const userDir = path.dirname(socketPath);
  try {
    if (fs.readdirSync(userDir).length > 0) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const directory of [userDir, path.dirname(userDir), path.dirname(path.dirname(userDir))]) {
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY') return;
      if (code !== 'ENOENT') throw error;
    }
  }
}
