import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'vibecodium.quality.json'), 'utf8'),
);
const pattern = manifest.branchNamePattern;
let branch = '';
try {
  branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
} catch {
  process.stderr.write('not_configured: cannot determine current branch\n');
  process.exitCode = 2;
}
if (process.exitCode === 2) {
  // Keep the not_configured result above.
} else if (typeof pattern !== 'string' || !pattern) {
  process.stderr.write('not_configured: branchNamePattern is missing\n');
  process.exitCode = 2;
} else if (!branch || !new RegExp(pattern).test(branch)) {
  process.stderr.write(
    `branch-name failed: ${branch || 'detached HEAD'} does not match ${pattern}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`branch-name passed: ${branch}\n`);
}
