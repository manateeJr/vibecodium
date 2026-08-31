import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

const repositoryRoot = process.cwd();
const markerPath = path.join(repositoryRoot, '.vibecodium', 'deployed-commit');
const cliShimPath = path.join(os.homedir(), '.local', 'bin', 'vibecodium');
const cliPath = path.join(repositoryRoot, 'dist', 'src', 'cli.js');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function provisionCliShim() {
  fs.mkdirSync(path.dirname(cliShimPath), { recursive: true });
  fs.writeFileSync(
    cliShimPath,
    `#!/usr/bin/env bash\nexec node ${shellQuote(cliPath)} "$@"\n`,
    'utf8',
  );
  fs.chmodSync(cliShimPath, 0o755);
  process.stdout.write(`deploy: provisioned ${cliShimPath}\n`);
}

function main() {
  try {
    const head = execSync('git rev-parse HEAD', {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';

    if (head === marker) {
      process.stdout.write(`deploy: up to date ${head.slice(0, 7)}\n`);
      return 0;
    }

    let markerIsValid = false;
    if (marker) {
      try {
        execFileSync('git', ['cat-file', '-e', `${marker}^{commit}`], {
          cwd: repositoryRoot,
          stdio: 'ignore',
        });
        markerIsValid = true;
      } catch {
        markerIsValid = false;
      }
    }

    let lockfileChanged = false;
    if (markerIsValid) {
      try {
        execFileSync('git', ['diff', '--quiet', marker, head, '--', 'package-lock.json'], {
          cwd: repositoryRoot,
          stdio: 'ignore',
        });
      } catch {
        lockfileChanged = true;
      }
    }

    if (
      !marker ||
      !markerIsValid ||
      lockfileChanged ||
      !fs.existsSync(path.join(repositoryRoot, 'node_modules'))
    ) {
      execFileSync(npm, ['ci'], { cwd: repositoryRoot, stdio: 'inherit' });
    }

    try {
      execFileSync(npm, ['run', 'build'], { cwd: repositoryRoot, stdio: 'inherit' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`deploy: build failed: ${message}\n`);
      return 1;
    }

    try {
      provisionCliShim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `deploy: CLI shim setup failed; command may not be available: ${message}\n`,
      );
    }

    try {
      execFileSync(npm, ['run', 'setup:substrate'], { cwd: repositoryRoot, stdio: 'inherit' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`deploy: substrate setup failed; sessions may not start: ${message}\n`);
    }
    try {
      execFileSync('systemctl', ['--user', 'restart', 'vibecodium'], {
        cwd: repositoryRoot,
        stdio: 'inherit',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`deploy: restart failed; build succeeded: ${message}\n`);
    }

    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${head}\n`, 'utf8');
    process.stdout.write(`deploy: updated ${head.slice(0, 7)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`deploy: failed: ${message}\n`);
    return 1;
  }
}

process.exitCode = main();
