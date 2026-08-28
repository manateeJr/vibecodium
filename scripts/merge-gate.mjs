import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from './evidence.mjs';

const branch = execFileSync('git', ['branch', '--show-current'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
if (branch !== 'main') {
  process.stdout.write(`merge-gate skipped: current branch is ${branch || 'detached HEAD'}\n`);
  process.exit(0);
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
const evidenceDirectory = path.join(repositoryRoot, '.vibecodium', 'evidence');
const evidenceFiles = fs.existsSync(evidenceDirectory)
  ? fs.readdirSync(evidenceDirectory).filter((file) => file.endsWith('.json'))
  : [];
const passingGate = evidenceFiles.some((file) => {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, file), 'utf8'));
    return (
      record.check_name === 'gate' &&
      record.profile === 'strict' &&
      record.head_commit === head &&
      record.exit_status === 0 &&
      record.status === 'passed'
    );
  } catch {
    return false;
  }
});
if (!passingGate) {
  process.stderr.write(`merge-gate failed: no passing full gate evidence for ${head}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`merge-gate passed: full gate evidence covers ${head}\n`);
}
