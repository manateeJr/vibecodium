import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.join(repositoryRoot, '.vibecodium');
const venvDirectory = path.join(dataDirectory, 'voice-venv');
const modelDirectory = path.join(dataDirectory, 'voice-models');
const defaultModel = 'base';
const fasterWhisperVersion = '1.2.1';
const defaultModelRevision = 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66';
const defaultModelChecksums = {
  'config.json': '56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a',
  'model.bin': 'd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9',
  'tokenizer.json': 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
  'vocabulary.txt': '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
};
const defaultModelSnapshotDirectory = path.join(
  modelDirectory,
  'models--Systran--faster-whisper-base',
  'snapshots',
  defaultModelRevision,
);
const model = process.env.VIBECODIUM_WHISPER_MODEL?.trim() || defaultModel;
const modelDownloadScript = [
  'import sys',
  'from faster_whisper import WhisperModel',
  'revision = sys.argv[3] or None',
  'model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", download_root=sys.argv[2], revision=revision)',
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
function verifyDefaultModel() {
  process.stdout.write('voice setup: verifying Whisper model checksums\n');
  for (const [filename, expectedChecksum] of Object.entries(defaultModelChecksums)) {
    const artifactPath = path.join(defaultModelSnapshotDirectory, filename);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(
        `Whisper model verification failed: ${artifactPath} is missing (expected sha256 ${expectedChecksum}).`,
      );
    }
    const actualChecksum = createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Whisper model verification failed for ${artifactPath}: expected sha256 ${expectedChecksum}, got ${actualChecksum}. Remove the model and rerun node scripts/setup-voice.mjs.`,
      );
    }
  }
  process.stdout.write('voice setup: Whisper model checksums verified\n');
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
    ['-m', 'pip', 'install', `faster-whisper==${fasterWhisperVersion}`],
    'voice setup: installing faster-whisper',
  );
  fs.mkdirSync(modelDirectory, { recursive: true });
  const revision = model === defaultModel ? defaultModelRevision : '';
  run(
    interpreter,
    ['-c', modelDownloadScript, model, modelDirectory, revision],
    `voice setup: downloading Whisper model "${model}"${
      revision ? ` at revision ${revision}` : ' without a pinned revision'
    } into ${modelDirectory}`,
  );
  if (model === defaultModel) {
    verifyDefaultModel();
  } else {
    process.stdout.write(
      `voice setup: skipping checksum verification for overridden Whisper model "${model}" (pinned checksums cover only default "${defaultModel}")\n`,
    );
  }
  process.stdout.write('voice ready\n');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`voice setup failed: ${message}\n`);
  process.exitCode = 1;
}
