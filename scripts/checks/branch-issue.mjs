import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'vibecodium.quality.json'), 'utf8'),
);
const bindingPath = path.join(
  repositoryRoot,
  manifest.branchBindingFile ?? '.vibecodium/branch.json',
);
const failures = [];
const warnings = [];

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

function mergeInProgress() {
  const mergeHead = git(['rev-parse', '--git-path', 'MERGE_HEAD']);
  return fs.existsSync(mergeHead) && fs.readFileSync(mergeHead, 'utf8').trim().length > 0;
}

function loadBinding() {
  const branch = git(['branch', '--show-current']);
  if (branch === 'main') return { issues: [] };
  if (!fs.existsSync(bindingPath)) {
    failures.push(`missing branch binding: ${path.relative(repositoryRoot, bindingPath)}`);
    return undefined;
  }
  try {
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    if (!Array.isArray(binding.issues) || binding.issues.length === 0) {
      failures.push('branch binding must declare at least one issue');
      return undefined;
    }
    if (!binding.issues.every((issue) => Number.isInteger(issue) && issue > 0)) {
      failures.push('branch binding issues must be positive integers');
      return undefined;
    }
    const branch = git(['branch', '--show-current']);
    if (!branch || binding.branch !== branch)
      failures.push(`branch binding does not match ${branch || 'detached HEAD'}`);
    return binding;
  } catch (error) {
    failures.push(
      `invalid branch binding: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function checkIssueStates(issues) {
  if (process.env.VIBECODIUM_SKIP_GH === '1') {
    warnings.push('VIBECODIUM_WARN gh issue state check not_configured (skipped)');
    return;
  }
  const availability = spawnSync('gh', ['--version'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (availability.error || availability.status !== 0) {
    warnings.push('VIBECODIUM_WARN gh issue state check not_configured');
    return;
  }
  const states = [];
  for (const issue of issues) {
    const result = spawnSync(
      'gh',
      ['issue', 'view', String(issue), '--json', 'state', '--jq', '.state'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    if (result.error || result.status !== 0) {
      warnings.push(`VIBECODIUM_WARN issue #${issue} state not_configured`);
      return;
    }
    states.push(result.stdout.trim().toUpperCase());
  }
  if (states.length > 0 && states.every((state) => state === 'CLOSED')) {
    failures.push('all declared branch issues are closed; stale branch binding');
  }
}

const binding = loadBinding();
if (binding && binding.issues.length > 0) checkIssueStates(binding.issues);

const messageIndex = process.argv.indexOf('--commit-message');
if (messageIndex >= 0) {
  const messagePath = process.argv[messageIndex + 1];
  let message = '';
  try {
    if (!messagePath) throw new Error('commit message path is missing');
    message = fs.readFileSync(messagePath, 'utf8');
  } catch (error) {
    failures.push(
      `cannot read commit message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (binding && binding.issues.length > 0 && message && !mergeInProgress()) {
    const references = [...message.matchAll(/(?:#|issue[-_\s#]*)(\d+)/gi)].map((match) =>
      Number(match[1]),
    );
    const declared = new Set(binding.issues);
    if (references.length !== 1 || !declared.has(references[0])) {
      failures.push('commit must reference exactly one declared branch issue');
    }
  }
}

for (const warning of warnings) process.stdout.write(`${warning}\n`);
if (failures.length > 0) {
  process.stderr.write(`branch-issue failed:\n${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('branch-issue passed\n');
}
