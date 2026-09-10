import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { COMMAND_NAMES, type MediaAttachResult } from '../contracts/commands.js';
import { mediaAttachArgs } from '../contracts/media-commands.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface MediaSubsystemOptions {
  readonly mediaDir?: string;
}

export class MediaSubsystem implements Subsystem {
  public readonly name = 'media';
  private readonly mediaDir: string | undefined;
  private registered = false;

  public constructor(options: MediaSubsystemOptions = {}) {
    this.mediaDir = options.mediaDir;
  }

  public register(context: SubsystemContext): void {
    if (this.registered) throw new Error('media subsystem is already registered');
    this.registered = true;
    context.registerCommand(COMMAND_NAMES.mediaAttach, (command: unknown) => this.attach(command));
  }

  public async attach(command: unknown): Promise<MediaAttachResult> {
    const args = mediaAttachArgs(command);
    const sessionId = safeSegment(args.session_id, 'session_id');
    if (args.mime !== undefined && !args.mime.toLowerCase().startsWith('image/')) {
      throw new Error('mime must be an image/* type');
    }
    if (args.filename !== undefined) safeMediaName(args.filename);
    const image = decodeBase64Image(args.image_base64);
    const extension = sniffImageExtension(image);
    const directory = path.join(mediaRoot(this.mediaDir), sessionId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${randomUUID()}${extension}`);
    await writeFile(target, image, { flag: 'wx' });
    return { path: path.resolve(target), size: image.byteLength };
  }
}

export function createMediaSubsystem(options: MediaSubsystemOptions = {}): MediaSubsystem {
  return new MediaSubsystem(options);
}

function mediaRoot(override: string | undefined): string {
  const env = process.env.VIBECODIUM_MEDIA_DIR;
  if (override) return override;
  if (env && env.trim()) return env;
  return path.join(os.homedir(), '.vibecodium', 'media');
}

function decodeBase64Image(value: string): Buffer {
  const trimmed = value.trim();
  const comma = trimmed.indexOf(',');
  const encoded = trimmed.startsWith('data:') && comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
  const compact = encoded.replaceAll(/\s+/g, '');
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const estimated = Math.floor((compact.length * 3) / 4) - padding;
  if (estimated > MAX_IMAGE_BYTES) {
    throw new Error(`image exceeds 15 MB limit (${estimated} bytes)`);
  }
  const image = Buffer.from(compact, 'base64');
  if (image.length === 0) throw new Error('image_base64 must contain image data');
  if (image.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image exceeds 15 MB limit (${image.byteLength} bytes)`);
  }
  return image;
}

function sniffImageExtension(image: Buffer): '.jpg' | '.png' | '.gif' | '.webp' {
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return '.jpg';
  }
  if (
    image.length >= 8 &&
    image[0] === 0x89 &&
    image[1] === 0x50 &&
    image[2] === 0x4e &&
    image[3] === 0x47 &&
    image[4] === 0x0d &&
    image[5] === 0x0a &&
    image[6] === 0x1a &&
    image[7] === 0x0a
  ) {
    return '.png';
  }
  if (
    image.length >= 4 &&
    image[0] === 0x47 &&
    image[1] === 0x49 &&
    image[2] === 0x46 &&
    image[3] === 0x38
  ) {
    return '.gif';
  }
  if (
    image.length >= 12 &&
    image[0] === 0x52 &&
    image[1] === 0x49 &&
    image[2] === 0x46 &&
    image[3] === 0x46 &&
    image[8] === 0x57 &&
    image[9] === 0x45 &&
    image[10] === 0x42 &&
    image[11] === 0x50
  ) {
    return '.webp';
  }
  throw new Error('unsupported image type');
}

function safeMediaName(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error('filename must be a non-empty filename');
  }
  const name = path.basename(value.replaceAll('\\', '/'));
  if (!name || name === '.' || name === '..') throw new Error('filename must be a filename');
  return name;
}

function safeSegment(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${field} must be a single path segment`);
  }
  return value;
}
