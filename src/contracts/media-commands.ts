/**
 * Telegram photo intake (issue #121). The bot persists inbound image bytes via
 * `media.attach` and drops the returned absolute path into the turn prompt.
 */
export const MEDIA_ATTACH_COMMAND = 'media.attach' as const;

export interface MediaAttachArgs {
  readonly session_id: string;
  readonly image_base64: string;
  readonly mime?: string;
  readonly filename?: string;
}

export interface MediaAttachResult {
  readonly path: string;
  readonly size: number;
}

export function mediaAttachArgs(command: unknown): MediaAttachArgs {
  const value = asRecord(command);
  if (!value) throw new Error('media.attach arguments must be an object');
  if (typeof value.session_id !== 'string' || !value.session_id) {
    throw new Error('session_id is required');
  }
  if (typeof value.image_base64 !== 'string') throw new Error('image_base64 is required');
  if (value.mime !== undefined && (typeof value.mime !== 'string' || !value.mime)) {
    throw new Error('mime must be a non-empty string');
  }
  if (value.filename !== undefined && (typeof value.filename !== 'string' || !value.filename)) {
    throw new Error('filename must be a non-empty string');
  }
  return {
    session_id: value.session_id,
    image_base64: value.image_base64,
    ...(value.mime === undefined ? {} : { mime: value.mime }),
    ...(value.filename === undefined ? {} : { filename: value.filename }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
