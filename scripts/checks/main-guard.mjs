import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

function worktrees() {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  const entries = [];
  let entry;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (entry) entries.push(entry);
      entry = { path: line.slice('worktree '.length) };
    } else if (entry && line.startsWith('branch ')) {
      entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (entry) entries.push(entry);
  return entries;
}

let entries;
try {
  entries = worktrees();
} catch (error) {
  process.stderr.write(
    `not_configured: cannot inspect git worktrees: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
if (!entries) {
  // Keep the not_configured result above.
} else {
  const primary = entries[0];
  const currentPath = fs.realpathSync(repositoryRoot);
  const primaryPath = primary ? fs.realpathSync(primary.path) : '';
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  if (branch === 'main' && currentPath !== primaryPath) {
    const message = `main-guard failed: main is only allowed in the primary worktree (${primary?.path ?? 'unknown'})`;
    const checkoutIndex = process.argv.indexOf('--checkout');
    if (checkoutIndex >= 0) {
      const oldHead = process.argv[checkoutIndex + 1];
      if (oldHead && /^[0-9a-f]{7,64}$/i.test(oldHead)) {
        try {
          execFileSync('git', ['switch', '--detach', oldHead], {
            cwd: repositoryRoot,
            encoding: 'utf8',
          });
        } catch {
          // The failure below remains authoritative if restoration is unavailable.
        }
      }
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`main-guard passed: ${branch || 'detached HEAD'}\n`);
  }
}
