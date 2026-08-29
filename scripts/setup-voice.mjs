import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.join(repositoryRoot, '.vibecodium');
const venvDirectory = path.join(dataDirectory, 'voice-venv');
const modelDirectory = path.join(dataDirectory, 'voice-models');
const model = process.env.VIBECODIUM_WHISPER_MODEL?.trim() || 'base';
const modelDownloadScript = [
  'import sys',
  'from faster_whisper import WhisperModel',
  'model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", download_root=sys.argv[2])',
  'del model',
].join('\n');

function commandSucceeded(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8' });
  return result.status === 0 && !result.error;
}

function run(command, args, label) {
  process.stdout.write(`${label}\n`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error instanceof Error ? `: ${result.error.message}` : '';
    throw new Error(`${label} failed${detail}`);
  }
}

function pythonPath() {
  return process.platform === 'win32'
    ? path.join(venvDirectory, 'Scripts', 'python.exe')
    : path.join(venvDirectory, 'bin', 'python');
}

function main() {
  process.stdout.write('voice setup: checking python3...\n');
  if (!commandSucceeded('python3', ['--version'])) {
    throw new Error(
      'python3 is required. Install Python 3, then rerun node scripts/setup-voice.mjs.',
    );
  }

  process.stdout.write('voice setup: checking ffmpeg...\n');
  if (!commandSucceeded('ffmpeg', ['-version'])) {
    throw new Error('ffmpeg is required. Install ffmpeg, then rerun node scripts/setup-voice.mjs.');
  }

  fs.mkdirSync(dataDirectory, { recursive: true });
  const interpreter = pythonPath();
  if (!fs.existsSync(interpreter)) {
    run(
      'python3',
      ['-m', 'venv', venvDirectory],
      `voice setup: creating isolated Python venv at ${venvDirectory}`,
    );
  } else {
    process.stdout.write(`voice setup: reusing isolated Python venv at ${venvDirectory}\n`);
  }

  run(
    interpreter,
    ['-m', 'pip', 'install', 'faster-whisper'],
    'voice setup: installing faster-whisper',
  );
  fs.mkdirSync(modelDirectory, { recursive: true });
  run(
    interpreter,
    ['-c', modelDownloadScript, model, modelDirectory],
    `voice setup: downloading Whisper model "${model}" into ${modelDirectory}`,
  );
  process.stdout.write('voice ready\n');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`voice setup failed: ${message}\n`);
  process.exitCode = 1;
}
