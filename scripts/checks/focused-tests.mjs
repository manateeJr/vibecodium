import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'vibecodium.quality.json'), 'utf8'),
);
const patterns = (manifest.forbiddenTestPatterns ?? []).map((pattern) => new RegExp(pattern));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && /(?:^|\/)(?:test|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
const failures = [];
for (const file of files) {
  const fullPath = path.join(repositoryRoot, file);
  const content = fs.readFileSync(fullPath, 'utf8');
  for (const pattern of patterns) {
    if (pattern.test(content)) failures.push(`${file}: ${pattern}`);
  }
}
if (failures.length > 0) {
  process.stderr.write(`focused-tests failed:\n${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`focused-tests passed: ${files.length} test file(s)\n`);
}
