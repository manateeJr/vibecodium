import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'vibecodium.quality.json'), 'utf8'),
);
const packagePath = path.join(repositoryRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const lockfiles = manifest.lockfiles ?? ['package-lock.json'];
const lockfileName = lockfiles.find((candidate) =>
  fs.existsSync(path.join(repositoryRoot, candidate)),
);
const failures = [];

if (!lockfileName) {
  failures.push(`missing lockfile (expected one of ${lockfiles.join(', ')})`);
} else if (lockfileName === 'package-lock.json') {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, lockfileName), 'utf8'));
    const root = lock.packages?.[''];
    if (!root) failures.push('package-lock.json has no root package metadata');
    else {
      for (const field of ['dependencies', 'devDependencies']) {
        const expected = JSON.stringify(packageJson[field] ?? {});
        const actual = JSON.stringify(root[field] ?? {});
        if (expected !== actual)
          failures.push(`${field} differ between package.json and package-lock.json`);
      }
    }
  } catch (error) {
    failures.push(
      `invalid ${lockfileName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (process.argv.includes('--staged')) {
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  if (staged.includes('package.json') && !staged.some((file) => lockfiles.includes(file))) {
    failures.push('package.json is staged without a matching lockfile update');
  }
}

if (failures.length > 0) {
  process.stderr.write(`lockfile-sync failed:\n${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`lockfile-sync passed: ${lockfileName ?? 'none'}\n`);
}
