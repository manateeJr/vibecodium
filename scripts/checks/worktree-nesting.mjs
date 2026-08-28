import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

function listedWorktrees() {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

let paths;
try {
  paths = listedWorktrees();
} catch (error) {
  process.stderr.write(
    `not_configured: cannot inspect git worktrees: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
if (!paths) {
  // Keep the not_configured result above.
} else {
  const root = fs.realpathSync(repositoryRoot);
  const nested = paths.filter((worktreePath) => {
    const resolved = fs.realpathSync(worktreePath);
    return resolved !== root && resolved.startsWith(`${root}${path.sep}`);
  });
  if (nested.length > 0) {
    process.stderr.write(`worktree-nesting failed:\n${nested.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`worktree-nesting passed: ${paths.length} worktree(s)\n`);
  }
}
