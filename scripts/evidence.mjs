import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptsDirectory, '..');
const evidenceDirectory = path.join(repositoryRoot, '.vibecodium', 'evidence');

function gitRevision(args) {
  try {
    return (
      execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function timestampForFilename(date) {
  return date.toISOString().replaceAll(':', '').replaceAll('.', '-');
}

export function writeEvidence({
  checkName,
  checkVersion = '1',
  command,
  output,
  exitStatus,
  startedAt,
  endedAt = new Date(),
  status,
}) {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const record = {
    check_name: checkName,
    check_version: checkVersion,
    command,
    repo: repositoryRoot,
    base_commit: gitRevision(['rev-parse', 'HEAD^']),
    head_commit: gitRevision(['rev-parse', 'HEAD']),
    profile: 'strict',
    actor: process.env.GIT_AUTHOR_NAME ?? process.env.USER ?? 'unknown',
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    exit_status: exitStatus,
    status: status ?? (exitStatus === 0 ? 'passed' : 'failed'),
    output_sha256: crypto.createHash('sha256').update(output).digest('hex'),
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const stem = `${timestampForFilename(startedAt)}-${checkName.replaceAll(/[^a-zA-Z0-9_.-]/g, '-')}`;
  let sequence = 0;
  while (true) {
    const suffix = sequence === 0 ? '' : `-${sequence}`;
    const destination = path.join(evidenceDirectory, `${stem}${suffix}.json`);
    try {
      fs.writeFileSync(destination, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return destination;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        sequence += 1;
        continue;
      }
      throw error;
    }
  }
}

export function runCommand(command, args, options = {}) {
  const startedAt = new Date();
  const result = options.spawn
    ? options.spawn(command, args)
    : (() => {
        try {
          return spawnSync(command, args, {
            cwd: repositoryRoot,
            encoding: 'utf8',
            maxBuffer: 20 * 1024 * 1024,
            ...options,
          });
        } catch (error) {
          return {
            status: 127,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      })();
  const endedAt = new Date();
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const output = `${stdout}${stderr ? `\n${stderr}` : ''}`;
  const exitStatus = typeof result.status === 'number' ? result.status : 127;
  return { startedAt, endedAt, output, exitStatus, result };
}
