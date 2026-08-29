import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  COMMAND_NAMES,
  type VoiceTranscribeArgs,
  type VoiceTranscribeResult,
} from '../contracts/commands.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import {
  createLocalTranscriber,
  type LocalTranscriberOptions,
  type VoiceTranscriber,
} from './transcriber.js';

const execFileAsync = promisify(execFile);

export type { VoiceTranscriber } from './transcriber.js';

export interface VoiceSubsystemOptions extends LocalTranscriberOptions {
  readonly transcriber?: VoiceTranscriber;
  readonly temporaryDirectory?: string;
}

export class VoiceSubsystem implements Subsystem {
  public readonly name = 'voice';
  private readonly transcriber: VoiceTranscriber;
  private readonly temporaryDirectory: string;
  private registered = false;

  public constructor(options: VoiceSubsystemOptions = {}) {
    this.transcriber = options.transcriber ?? createLocalTranscriber(options);
    this.temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
  }

  public register(context: SubsystemContext): void {
    if (this.registered) throw new Error('voice subsystem is already registered');
    this.registered = true;
    context.registerCommand(COMMAND_NAMES.voiceTranscribe, (command: unknown) =>
      this.transcribe(command),
    );
  }

  public async transcribe(command: unknown): Promise<VoiceTranscribeResult> {
    const args = voiceTranscribeArgs(command);
    const audio = decodeBase64Audio(args.audio_base64);
    const directory = await fs.promises.mkdtemp(
      path.join(this.temporaryDirectory, 'vibecodium-voice-'),
    );

    try {
      const inputPath = path.join(directory, `input${audioExtension(args.mime)}`);
      await fs.promises.writeFile(inputPath, audio);
      const wavPath = needsWavConversion(audio, args.mime)
        ? path.join(directory, 'audio.wav')
        : inputPath;
      if (wavPath !== inputPath) await convertToWav(inputPath, wavPath);
      const text = await this.transcriber(wavPath);
      return { text: text.trim() };
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function createVoiceSubsystem(options: VoiceSubsystemOptions = {}): VoiceSubsystem {
  return new VoiceSubsystem(options);
}

function voiceTranscribeArgs(command: unknown): VoiceTranscribeArgs {
  if (!command || typeof command !== 'object' || Array.isArray(command))
    throw new Error('audio_base64 is required');
  const value = command as Record<string, unknown>;
  if (typeof value.audio_base64 !== 'string' || !value.audio_base64.trim())
    throw new Error('audio_base64 is required');
  if (value.mime !== undefined && (typeof value.mime !== 'string' || !value.mime.trim()))
    throw new Error('mime must be a non-empty string');
  return {
    audio_base64: value.audio_base64,
    ...(value.mime === undefined ? {} : { mime: value.mime }),
  };
}

function decodeBase64Audio(value: string): Buffer {
  const trimmed = value.trim();
  const comma = trimmed.indexOf(',');
  const encoded = trimmed.startsWith('data:') && comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
  const bytes = Buffer.from(encoded.replaceAll(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw new Error('audio_base64 must contain audio data');
  return bytes;
}

function needsWavConversion(audio: Buffer, mime: string | undefined): boolean {
  if (isWavMime(mime)) return false;
  return !(
    audio.length >= 12 &&
    audio.subarray(0, 4).toString('ascii') === 'RIFF' &&
    audio.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

function audioExtension(mime: string | undefined): string {
  const normalized = mime?.split(';', 1)[0]?.trim().toLowerCase();
  switch (normalized) {
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return '.wav';
    case 'audio/mpeg':
      return '.mp3';
    case 'audio/mp4':
      return '.m4a';
    case 'audio/webm':
      return '.webm';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/flac':
      return '.flac';
    default:
      return '.audio';
  }
}

function isWavMime(mime: string | undefined): boolean {
  const normalized = mime?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized === 'audio/wav' || normalized === 'audio/wave' || normalized === 'audio/x-wav';
}

async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        outputPath,
      ],
      { encoding: 'utf8', maxBuffer: 1 * 1024 * 1024 },
    );
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(
      `Unable to convert audio with ffmpeg. Install ffmpeg and run node scripts/setup-voice.mjs again. ${detail}`,
    );
  }
}
