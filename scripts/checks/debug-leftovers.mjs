import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'vibecodium.quality.json'), 'utf8'),
);
const patterns = (manifest.debugWarningPatterns ?? []).map((pattern) => new RegExp(pattern));
const files = execFileSync('git', ['ls-files', 'src', '-z'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter((file) => file && /\.(?:cjs|js|mjs|ts|tsx)$/.test(file));
const warnings = [];
for (const file of files) {
  const content = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
  for (const pattern of patterns) {
    if (pattern.test(content)) warnings.push(`${file}: ${pattern}`);
  }
}
if (warnings.length > 0) {
  process.stdout.write(`VIBECODIUM_WARN debug leftovers:\n${warnings.join('\n')}\n`);
} else {
  process.stdout.write('debug-leftovers passed: no console.log/debugger in src\n');
}
