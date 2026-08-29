import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = 'base';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const TRANSCRIBE_SCRIPT = [
  'import sys',
  'from faster_whisper import WhisperModel',
  'model_name, audio_path, model_dir = sys.argv[1:4]',
  'model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=model_dir)',
  'segments, _ = model.transcribe(audio_path, beam_size=5)',
  'sys.stdout.write("".join(segment.text for segment in segments))',
].join('\n');

export type VoiceTranscriber = (wavPath: string) => string | PromiseLike<string>;

export interface LocalTranscriberOptions {
  readonly venvDirectory?: string;
  readonly modelDirectory?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export function createLocalTranscriber(options: LocalTranscriberOptions = {}): VoiceTranscriber {
  const venvDirectory = options.venvDirectory ?? defaultVoiceVenvDirectory();
  const modelDirectory =
    options.modelDirectory ?? path.join(repositoryRoot(), '.vibecodium', 'voice-models');
  const configuredModel = process.env.VIBECODIUM_WHISPER_MODEL?.trim();
  const model = options.model ?? (configuredModel || DEFAULT_MODEL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!model.trim()) throw new Error('VIBECODIUM_WHISPER_MODEL must be a non-empty model name');

  return async (wavPath: string): Promise<string> => {
    const pythonPath = pythonExecutable(venvDirectory);
    if (!fs.existsSync(pythonPath)) throw missingVoiceSetupError(venvDirectory);

    await fs.promises.mkdir(modelDirectory, { recursive: true });
    try {
      const { stdout } = await execFileAsync(
        pythonPath,
        ['-c', TRANSCRIBE_SCRIPT, model, wavPath, modelDirectory],
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      return stdout;
    } catch (error) {
      const detail = processErrorDetail(error);
      if (detail.includes('No module named') || detail.includes('faster_whisper')) {
        throw new Error(
          `The local voice environment is incomplete. Run node scripts/setup-voice.mjs to install faster-whisper. ${detail}`,
        );
      }
      throw new Error(`Voice transcription failed: ${detail}`);
    }
  };
}

export function defaultVoiceVenvDirectory(): string {
  const configured = process.env.VIBECODIUM_VOICE_VENV?.trim();
  return configured || path.join(repositoryRoot(), '.vibecodium', 'voice-venv');
}

export function pythonExecutable(venvDirectory: string): string {
  return process.platform === 'win32'
    ? path.join(venvDirectory, 'Scripts', 'python.exe')
    : path.join(venvDirectory, 'bin', 'python');
}

export function missingVoiceSetupError(venvDirectory: string): Error {
  return new Error(
    `Local voice transcription is not configured (missing ${pythonExecutable(venvDirectory)}). Run node scripts/setup-voice.mjs first.`,
  );
}

function repositoryRoot(): string {
  let current = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function processErrorDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = error.stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
