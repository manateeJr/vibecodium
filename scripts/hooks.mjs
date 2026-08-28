import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { repositoryRoot, writeEvidence } from './evidence.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const mode = process.argv[2];
const stagedFiles = getStagedFiles();
const supportedPrettier = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const supportedEslint = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);

function getStagedFiles() {
  try {
    const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function runCheck(checkName, command, args, options = {}) {
  const startedAt = new Date();
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    result = {
      status: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      error,
    };
  }
  const output = `${result.stdout ?? ''}${result.stderr ? `\n${result.stderr}` : ''}`;
  const exitStatus = typeof result.status === 'number' ? result.status : 127;
  const status = exitStatus === 0 ? 'passed' : result.error ? 'not_configured' : 'failed';
  writeEvidence({
    checkName,
    command: `${command} ${args.join(' ')}`,
    output,
    exitStatus,
    startedAt,
    endedAt: new Date(),
    status,
  });
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  return exitStatus;
}

function stagedDiff() {
  try {
    return execFileSync('git', ['diff', '--cached', '--no-ext-diff', '--unified=0'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
  } catch {
    return '';
  }
}

function secretScan() {
  const addedLines = stagedDiff()
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  const patterns = [
    /-----BEGIN (?:RSA|OPENSSH|EC|DSA|PRIVATE) KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
  ];
  return patterns.some((pattern) => pattern.test(addedLines));
}

function issueLinkPresent() {
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  const context = `${process.env.VIBECODIUM_ISSUE_REF ?? ''}\n${branch}\n${stagedDiff()}`;
  return /(?:#\d+|issue[-_\s#]*\d+|slice[-_/]\d+)/i.test(context);
}

function writeSkipped(checkName, command) {
  writeEvidence({
    checkName,
    command,
    output: '',
    exitStatus: 0,
    startedAt: new Date(),
    status: 'passed',
  });
}

function runPreCommit() {
  let status = 0;
  const prettierFiles = stagedFiles.filter((file) => supportedPrettier.has(path.extname(file)));
  if (prettierFiles.length > 0) {
    const executable = path.join(repositoryRoot, 'node_modules', '.bin', 'prettier');
    const checkStatus = runCheck(
      'pre-commit-format',
      fs.existsSync(executable) ? executable : 'prettier',
      ['--check', ...prettierFiles],
    );
    if (status === 0 && checkStatus !== 0) status = checkStatus;
  } else {
    writeSkipped('pre-commit-format', 'prettier --check (no applicable staged files)');
  }

  const eslintFiles = stagedFiles.filter((file) => supportedEslint.has(path.extname(file)));
  if (eslintFiles.length > 0) {
    const executable = path.join(repositoryRoot, 'node_modules', '.bin', 'eslint');
    const checkStatus = runCheck(
      'pre-commit-lint',
      fs.existsSync(executable) ? executable : 'eslint',
      eslintFiles,
    );
    if (status === 0 && checkStatus !== 0) status = checkStatus;
  } else {
    writeSkipped('pre-commit-lint', 'eslint (no applicable staged files)');
  }

  const secretStartedAt = new Date();
  const secretFound = secretScan();
  writeEvidence({
    checkName: 'pre-commit-secret-scan',
    command: 'staged diff secret regex scan',
    output: secretFound ? 'potential secret pattern found\n' : 'no secret patterns found\n',
    exitStatus: secretFound ? 1 : 0,
    startedAt: secretStartedAt,
    endedAt: new Date(),
    status: secretFound ? 'failed' : 'passed',
  });
  if (secretFound && status === 0) status = 1;

  const issueStartedAt = new Date();
  const issueFound = issueLinkPresent();
  writeEvidence({
    checkName: 'pre-commit-issue-link',
    command: 'staged commit context issue-link check',
    output: issueFound ? 'issue reference found\n' : 'missing issue reference\n',
    exitStatus: issueFound ? 0 : 1,
    startedAt: issueStartedAt,
    endedAt: new Date(),
    status: issueFound ? 'passed' : 'failed',
  });
  if (!issueFound && status === 0) status = 1;

  const maxFileStatus = runCheck('pre-commit-max-file-lines', process.execPath, [
    path.join(repositoryRoot, 'scripts', 'max-file-lines.mjs'),
    '--staged',
  ]);
  if (status === 0 && maxFileStatus !== 0) status = maxFileStatus;
  if (status !== 0) process.stderr.write('pre-commit failed\n');
  process.exitCode = status;
}

function runPrePush() {
  const status = runCheck('pre-push-gate', npm, ['run', 'gate'], {
    env: { ...process.env, CI: '1' },
  });
  if (status !== 0) process.stderr.write('pre-push failed\n');
  process.exitCode = status;
}

if (mode === 'pre-commit') runPreCommit();
else if (mode === 'pre-push') runPrePush();
else {
  const startedAt = new Date();
  writeEvidence({
    checkName: 'hook-unknown',
    command: `node scripts/hooks.mjs ${mode ?? ''}`,
    output: 'unknown hook mode\n',
    exitStatus: 2,
    startedAt,
    endedAt: new Date(),
    status: 'failed',
  });
  process.stderr.write(`unknown hook mode: ${mode ?? '(missing)'}\n`);
  process.exitCode = 2;
}
