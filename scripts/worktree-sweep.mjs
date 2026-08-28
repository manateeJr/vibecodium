import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from './evidence.mjs';

const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'vibecodium.quality.json'), 'utf8'),
);
const ageDays = Number(manifest.staleWorktreeDays ?? 14);
const shouldPrune = process.argv.includes('--prune');
const now = Math.floor(Date.now() / 1000);
const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
const entries = [];
let entry;
for (const line of output.split('\n')) {
  if (line.startsWith('worktree ')) {
    if (entry) entries.push(entry);
    entry = { path: line.slice('worktree '.length), branch: '', head: '' };
  } else if (entry && line.startsWith('HEAD ')) entry.head = line.slice(5);
  else if (entry && line.startsWith('branch '))
    entry.branch = line.slice(7).replace(/^refs\/heads\//, '');
}
if (entry) entries.push(entry);
const primary = fs.realpathSync(repositoryRoot);
for (const candidate of entries) {
  const candidatePath = fs.realpathSync(candidate.path);
  if (candidatePath === primary || !candidate.branch || candidate.branch === 'main') continue;
  const clean =
    execFileSync('git', ['-C', candidate.path, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim() === '';
  let commitTime = 0;
  try {
    commitTime = Number(
      execFileSync('git', ['-C', candidate.path, 'log', '-1', '--format=%ct'], {
        encoding: 'utf8',
      }).trim(),
    );
  } catch {
    continue;
  }
  const age = (now - commitTime) / 86_400;
  let merged = false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', candidate.head, 'main'], {
      cwd: repositoryRoot,
    });
    merged = true;
  } catch {
    merged = false;
  }
  const stale = merged && clean && age > ageDays;
  process.stdout.write(
    `${candidate.branch} ${candidate.path} merged=${merged} clean=${clean} age_days=${age.toFixed(1)}${stale ? ' STALE' : ''}\n`,
  );
  if (stale && shouldPrune) {
    execFileSync('git', ['worktree', 'remove', candidate.path], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
    process.stdout.write(`pruned ${candidate.path}\n`);
  }
}
if (!shouldPrune)
  process.stdout.write('dry-run: use --prune to remove merged, aged, clean worktrees\n');
