import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'vibecodium.quality.json'), 'utf8'),
);
const mode = process.argv.includes('--commit') ? 'commit' : 'gate';

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

if (manifest.primaryCheckout !== 'merge-only') {
  process.stderr.write('not_configured: primaryCheckout must be merge-only\n');
  process.exitCode = 2;
} else {
  let gitDir;
  let commonDir;
  try {
    gitDir = path.resolve(repositoryRoot, git(['rev-parse', '--git-dir']));
    commonDir = path.resolve(repositoryRoot, git(['rev-parse', '--git-common-dir']));
  } catch (error) {
    process.stderr.write(
      `not_configured: cannot identify checkout: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
  if (gitDir && commonDir && gitDir !== commonDir) {
    process.stdout.write('primary-merge-only passed: linked worktree is an authoring checkout\n');
  } else if (gitDir && commonDir && mode === 'gate') {
    process.stdout.write('primary-merge-only passed: primary validation run\n');
  } else if (gitDir && commonDir) {
    const mergeHead = git(['rev-parse', '--git-path', 'MERGE_HEAD']);
    const mergeInProgress =
      fs.existsSync(mergeHead) && fs.readFileSync(mergeHead, 'utf8').trim().length > 0;
    const parentCount = git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).length - 1;
    if (mergeInProgress || parentCount > 1) {
      process.stdout.write('primary-merge-only passed: merge commit is authorized\n');
    } else {
      process.stderr.write(
        'primary-merge-only failed: primary is merge-only; author in a sibling worktree\n',
      );
      process.exitCode = 1;
    }
  }
}
