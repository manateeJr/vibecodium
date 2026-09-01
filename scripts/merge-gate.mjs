import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryRoot } from './evidence.mjs';

export const MIN_SOAK_DURATION_MS = 10 * 60 * 1000;

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
const records = evidenceFiles.flatMap((file) => {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, file), 'utf8'));
    return record && typeof record === 'object' ? [record] : [];
  } catch {
    return [];
  }
});
const passingGate = records.some(
  (record) =>
    record.check_name === 'gate' &&
    record.profile === 'strict' &&
    record.head_commit === head &&
    record.exit_status === 0 &&
    record.status === 'passed',
);
const soakEvidence = records.find(
  (record) =>
    record.check_name === 'soak' &&
    record.profile === 'strict' &&
    record.head_commit === head &&
    record.exit_status === 0 &&
    record.status === 'passed' &&
    evidenceDuration(record) >= MIN_SOAK_DURATION_MS,
);
const soakDuration = records
  .filter(
    (record) =>
      record.check_name === 'soak' &&
      record.profile === 'strict' &&
      record.head_commit === head &&
      record.exit_status === 0 &&
      record.status === 'passed',
  )
  .map(evidenceDuration)
  .reduce((maximum, duration) => Math.max(maximum, duration), 0);
const failures = [];
if (!passingGate) failures.push(`no passing full gate evidence for ${head}`);
if (!soakEvidence)
  failures.push(
    `no passing soak evidence for ${head} with duration >= ${MIN_SOAK_DURATION_MS}ms (best=${soakDuration}ms)`,
  );
if (failures.length > 0) {
  process.stderr.write(`merge-gate failed: ${failures.join('; ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `merge-gate passed: full gate and ${soakDuration}ms soak evidence cover ${head}\n`,
  );
}

function evidenceDuration(record) {
  for (const value of [record.metrics?.durationMs, record.duration_ms, record.durationMs]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  const started = Date.parse(record.started_at);
  const ended = Date.parse(record.ended_at);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started
    ? ended - started
    : 0;
}
