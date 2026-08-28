import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { repositoryRoot } from './evidence.mjs';

const issues = process.argv.slice(2).map((value) => Number(value));
if (issues.length === 0 || issues.some((issue) => !Number.isInteger(issue) || issue < 1)) {
  process.stderr.write('usage: scripts/branch-init <issue> [issue ...]\n');
  process.exitCode = 2;
} else {
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  if (!branch || branch === 'main') {
    process.stderr.write('branch-init requires a non-main branch\n');
    process.exitCode = 1;
  } else {
    const bindingPath = path.join(repositoryRoot, '.vibecodium', 'branch.json');
    fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
    fs.writeFileSync(
      bindingPath,
      `${JSON.stringify({ branch, issues: [...new Set(issues)].sort((a, b) => a - b), initialized_at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    const warnings = [];
    if (process.env.VIBECODIUM_SKIP_GH === '1')
      warnings.push('VIBECODIUM_WARN gh label step not_configured (skipped)');
    else {
      const available = spawnSync('gh', ['--version'], { cwd: repositoryRoot, encoding: 'utf8' });
      if (available.error || available.status !== 0)
        warnings.push('VIBECODIUM_WARN gh label step not_configured');
      else {
        for (const issue of [...new Set(issues)]) {
          const result = spawnSync(
            'gh',
            ['issue', 'edit', String(issue), '--add-label', 'in-progress'],
            {
              cwd: repositoryRoot,
              encoding: 'utf8',
              timeout: 5_000,
            },
          );
          if (result.error || result.status !== 0)
            warnings.push(`VIBECODIUM_WARN could not label issue #${issue}`);
        }
      }
    }
    for (const warning of warnings) process.stdout.write(`${warning}\n`);
    process.stdout.write(
      `branch binding initialized for ${branch}: ${[...new Set(issues)].join(', ')}\n`,
    );
  }
}
