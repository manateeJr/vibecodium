import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

const packagePath = path.join(repositoryRoot, 'package.json');
const approvalPath = path.join(repositoryRoot, '.vibecodium', 'dep-approvals.json');
const current = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
let baseline = {};
try {
  baseline = JSON.parse(
    execFileSync('git', ['show', 'HEAD:package.json'], { cwd: repositoryRoot, encoding: 'utf8' }),
  );
} catch {
  baseline = {};
}
const currentDeps = { ...current.dependencies, ...current.devDependencies };
const baselineDeps = { ...baseline.dependencies, ...baseline.devDependencies };
const additions = Object.keys(currentDeps).filter((name) => !(name in baselineDeps));
const failures = [];
let approvals = {};
if (additions.length > 0) {
  try {
    approvals = JSON.parse(fs.readFileSync(approvalPath, 'utf8')).approvals ?? {};
  } catch (error) {
    failures.push(
      `cannot read dependency approvals: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const dependency of additions) {
    const approval = approvals[dependency];
    if (
      !approval ||
      typeof approval.reason !== 'string' ||
      !approval.reason.trim() ||
      typeof approval.approver !== 'string' ||
      !approval.approver.trim()
    ) {
      failures.push(`${dependency} needs reason + approver in .vibecodium/dep-approvals.json`);
    }
  }
}
if (failures.length > 0) {
  process.stderr.write(`dependency-approval failed:\n${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    additions.length > 0
      ? `dependency-approval passed: ${additions.join(', ')}\n`
      : 'dependency-approval passed: no new dependencies\n',
  );
}
