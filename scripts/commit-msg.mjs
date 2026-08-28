import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repositoryRoot, writeEvidence } from './evidence.mjs';

const messagePath = process.argv[2];
const startedAt = new Date();
let result;
if (!messagePath) {
  result = {
    status: 2,
    stdout: '',
    stderr: 'commit message path is missing\n',
    error: new Error('missing path'),
  };
} else {
  result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts', 'checks', 'branch-issue.mjs'),
      '--commit-message',
      messagePath,
    ],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
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
  checkName: 'commit-msg-issue-link',
  command: 'branch issue binding commit-link check',
  output,
  exitStatus,
  startedAt,
  endedAt: new Date(),
  status,
});
if (output) process.stdout.write(output);
process.exitCode = exitStatus;
