import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repositoryRoot } from './evidence.mjs';

const bindingPath = path.join(repositoryRoot, '.vibecodium', 'branch.json');
if (!fs.existsSync(bindingPath)) {
  process.stdout.write('branch-clear: no binding present\n');
  process.exit(0);
}
const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
const warnings = [];
if (process.env.VIBECODIUM_SKIP_GH === '1')
  warnings.push('VIBECODIUM_WARN gh label step not_configured (skipped)');
else {
  const available = spawnSync('gh', ['--version'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (available.error || available.status !== 0)
    warnings.push('VIBECODIUM_WARN gh label step not_configured');
  else {
    for (const issue of binding.issues ?? []) {
      const result = spawnSync(
        'gh',
        ['issue', 'edit', String(issue), '--remove-label', 'in-progress'],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      if (result.error || result.status !== 0)
        warnings.push(`VIBECODIUM_WARN could not clear issue #${issue}`);
    }
  }
}
fs.rmSync(bindingPath);
for (const warning of warnings) process.stdout.write(`${warning}\n`);
process.stdout.write(`branch binding cleared for ${binding.branch ?? 'unknown branch'}\n`);
