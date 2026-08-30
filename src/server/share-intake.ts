import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SHARED_STAGE_METADATA_FILENAME } from '../contracts/files-commands.js';
import { MultipartError, parseMultipart } from './multipart.js';

const DEFAULT_SHARED_DIR = path.join(os.homedir(), '.vibecodium', 'shared');

export interface ShareIntakeOptions {
  readonly sharedRoot?: string;
  readonly maxBytes?: number;
}

export async function handleShareIntake(
  request: IncomingMessage,
  response: ServerResponse,
  options: ShareIntakeOptions = {},
): Promise<void> {
  try {
    const form = await parseMultipart(request, options.maxBytes);
    const sharedRoot = path.resolve(
      options.sharedRoot ?? process.env.VIBECODIUM_SHARED_DIR ?? DEFAULT_SHARED_DIR,
    );
    const token = randomUUID();
    const tokenDirectory = path.join(sharedRoot, token);
    await mkdir(tokenDirectory, { recursive: true });
    const filePath = path.join(tokenDirectory, form.file.filename);
    await writeFile(filePath, form.file.content, { flag: 'wx' });
    await writeFile(
      path.join(tokenDirectory, SHARED_STAGE_METADATA_FILENAME),
      JSON.stringify(form.fields),
      { flag: 'wx' },
    );
    sendJson(response, 200, { token, path: filePath });
  } catch (error: unknown) {
    if (error instanceof MultipartError) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
  });
  response.end(body);
}
