import { spawnSync } from 'node:child_process';
import { writeEvidence, repositoryRoot } from './evidence.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;
const checks = [
  ['max-file-lines', node, ['scripts/max-file-lines.mjs', '--all']],
  ['branch-name', node, ['scripts/checks/branch-name.mjs']],
  ['branch-issue', node, ['scripts/checks/branch-issue.mjs']],
  ['worktree-nesting', node, ['scripts/checks/worktree-nesting.mjs']],
  ['main-guard', node, ['scripts/checks/main-guard.mjs']],
  ['focused-tests', node, ['scripts/checks/focused-tests.mjs']],
  ['lockfile-sync', node, ['scripts/checks/lockfile-sync.mjs']],
  ['dependency-approval', node, ['scripts/checks/dependency-approval.mjs']],
  ['debug-leftovers', node, ['scripts/checks/debug-leftovers.mjs']],
  ['npm-audit', node, ['scripts/checks/npm-audit.mjs']],
  ['typecheck', npm, ['run', 'typecheck']],
  ['lint', npm, ['run', 'lint']],
  ['format', npm, ['run', 'format:check']],
  ['test', npm, ['test']],
  ['merge-gate', node, ['scripts/merge-gate.mjs']],
];

let overallStatus = 0;
const gateStartedAt = new Date();
const outputs = [];

for (const [name, command, args] of checks) {
  const startedAt = new Date();
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: '1' },
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
  const status =
    exitStatus === 0
      ? output.includes('VIBECODIUM_WARN')
        ? 'warn'
        : 'passed'
      : result.error
        ? 'not_configured'
        : 'failed';
  writeEvidence({
    checkName: `gate-${name}`,
    command: `${command} ${args.join(' ')}`,
    output,
    exitStatus,
    startedAt,
    endedAt: new Date(),
    status,
  });
  outputs.push(`[${name}] ${output}`);
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  if (exitStatus !== 0 && overallStatus === 0) overallStatus = exitStatus;
}

const gateOutput = outputs.join('\n');
writeEvidence({
  checkName: 'gate',
  command: checks.map(([, command, args]) => `${command} ${args.join(' ')}`).join(' && '),
  output: gateOutput,
  exitStatus: overallStatus,
  startedAt: gateStartedAt,
  endedAt: new Date(),
  status:
    overallStatus === 0 ? (gateOutput.includes('VIBECODIUM_WARN') ? 'warn' : 'passed') : 'failed',
});

if (overallStatus !== 0) {
  process.stderr.write(`gate failed with exit status ${overallStatus}\n`);
}
process.exitCode = overallStatus;
