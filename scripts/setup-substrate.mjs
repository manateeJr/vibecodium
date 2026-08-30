import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(repositoryRoot, 'third_party', 'abduco');
const outputDirectory = path.join(repositoryRoot, '.vibecodium', 'bin');
const outputPath = path.join(outputDirectory, 'abduco');
const sourceFiles = [
  'abduco.c',
  'client.c',
  'server.c',
  'debug.c',
  'forkpty-aix.c',
  'forkpty-sunos.c',
  'config.def.h',
  'Makefile',
];

function sourceMtime() {
  return Math.max(
    ...sourceFiles.map((file) => fs.statSync(path.join(sourceDirectory, file)).mtimeMs),
  );
}

function compilerAvailable() {
  const result = spawnSync('cc', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function compile(buildDirectory) {
  for (const file of sourceFiles.filter((candidate) => candidate.endsWith('.c'))) {
    fs.copyFileSync(path.join(sourceDirectory, file), path.join(buildDirectory, file));
  }
  fs.copyFileSync(
    path.join(sourceDirectory, 'config.def.h'),
    path.join(buildDirectory, 'config.h'),
  );

  const result = spawnSync(
    'cc',
    [
      '-std=c99',
      '-D_POSIX_C_SOURCE=200809L',
      '-D_XOPEN_SOURCE=700',
      '-DNDEBUG',
      '-DVERSION="0.6"',
      'abduco.c',
      '-lc',
      '-lutil',
      '-o',
      'abduco',
    ],
    { cwd: buildDirectory, stdio: 'inherit' },
  );
  if (result.error || result.status !== 0) {
    const detail = result.error instanceof Error ? `: ${result.error.message}` : '';
    throw new Error(`cc failed while compiling vendored abduco${detail}`);
  }
}

function main() {
  for (const file of sourceFiles) {
    const sourcePath = path.join(sourceDirectory, file);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`vendored abduco source is missing: ${sourcePath}`);
    }
  }
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).mtimeMs >= sourceMtime()) {
    process.stdout.write(`substrate setup: abduco is up to date at ${outputPath}\n`);
    return;
  }
  if (!compilerAvailable()) {
    throw new Error(
      'cc is required to build abduco. Install a C compiler (for example GCC or Clang), then rerun npm run setup:substrate.',
    );
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-abduco-'));
  try {
    process.stdout.write('substrate setup: compiling vendored abduco with cc\n');
    compile(buildDirectory);
    fs.renameSync(path.join(buildDirectory, 'abduco'), outputPath);
    fs.chmodSync(outputPath, 0o755);
    process.stdout.write(`substrate setup: installed ${outputPath}\n`);
  } finally {
    fs.rmSync(buildDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`substrate setup failed: ${message}\n`);
  process.exitCode = 1;
}
