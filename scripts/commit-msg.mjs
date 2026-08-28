import fs from 'node:fs';
import { writeEvidence } from './evidence.mjs';

const messagePath = process.argv[2];
const startedAt = new Date();
let message = '';
try {
  if (!messagePath) throw new Error('commit message path is missing');
  message = fs.readFileSync(messagePath, 'utf8');
} catch (error) {
  const output = `not_configured: ${error instanceof Error ? error.message : String(error)}\n`;
  writeEvidence({
    checkName: 'commit-msg-issue-link',
    command: 'commit message issue-link check',
    output,
    exitStatus: 2,
    startedAt,
    endedAt: new Date(),
    status: 'not_configured',
  });
  process.stderr.write(output);
  process.exitCode = 2;
}

if (message) {
  const valid = /(?:#\d+|issue[-_\s#]*\d+)/i.test(message);
  const output = valid ? 'issue reference found\n' : 'missing issue reference\n';
  writeEvidence({
    checkName: 'commit-msg-issue-link',
    command: 'commit message issue-link check',
    output,
    exitStatus: valid ? 0 : 1,
    startedAt,
    endedAt: new Date(),
    status: valid ? 'passed' : 'failed',
  });
  if (!valid) {
    process.stderr.write('commit message must reference an issue (for example: #1)\n');
    process.exitCode = 1;
  }
}
