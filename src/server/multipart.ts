import type { IncomingMessage } from 'node:http';
import path from 'node:path';

const DEFAULT_MAX_MULTIPART_BYTES = 200 * 1024 * 1024;
const CRLF = Buffer.from('\r\n');
const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');

export class MultipartError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'MultipartError';
    this.statusCode = statusCode;
  }
}

export interface MultipartFile {
  readonly filename: string;
  readonly content: Buffer;
}

export interface MultipartForm {
  readonly file: MultipartFile;
  readonly fields: Readonly<Record<string, string>>;
}
export interface MultipartPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly data: Buffer;
}

export async function parseMultipartParts(
  request: Pick<IncomingMessage, 'headers'> & AsyncIterable<Buffer | string>,
  maxBytes = DEFAULT_MAX_MULTIPART_BYTES,
): Promise<readonly MultipartPart[]> {
  const contentType = request.headers['content-type'];
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  const boundary = parseBoundary(header);
  const body = await readBody(request, maxBytes);
  return parseParts(body, boundary);
}

export async function parseMultipart(
  request: Pick<IncomingMessage, 'headers'> & AsyncIterable<Buffer | string>,
  maxBytes = DEFAULT_MAX_MULTIPART_BYTES,
): Promise<MultipartForm> {
  const parts = await parseMultipartParts(request, maxBytes);
  let file: MultipartFile | undefined;
  const fields: Record<string, string> = {};
  for (const part of parts) {
    if (part.name === 'file') {
      if (file) throw new MultipartError(400, 'only one file part is supported');
      if (part.filename === undefined) throw new MultipartError(400, 'file filename is required');
      file = { filename: part.filename, content: part.data };
    } else if (part.name === 'note' || part.name === 'project') {
      if (part.name in fields) throw new MultipartError(400, `duplicate ${part.name} field`);
      fields[part.name] = part.data.toString('utf8');
    }
  }
  if (!file) throw new MultipartError(400, 'file part is required');
  return { file, fields };
}

function parseBoundary(contentType: string | undefined): string {
  if (!contentType || !/^multipart\/form-data(?:\s*;|\s*$)/i.test(contentType)) {
    throw new MultipartError(400, 'multipart boundary is required');
  }
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2])?.trim();
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw new MultipartError(400, 'multipart boundary is required');
  }
  return boundary;
}

async function readBody(
  request: AsyncIterable<Buffer | string>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > maxBytes) throw new MultipartError(413, 'multipart body exceeds 200 MB limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function parseParts(body: Buffer, boundary: string): readonly MultipartPart[] {
  const marker = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.concat([CRLF, marker]);
  if (!body.subarray(0, marker.length).equals(marker)) {
    throw new MultipartError(400, 'malformed multipart body');
  }
  let cursor = marker.length;
  const parts: MultipartPart[] = [];
  while (true) {
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    if (!body.subarray(cursor, cursor + 2).equals(CRLF)) {
      throw new MultipartError(400, 'malformed multipart boundary');
    }
    cursor += 2;
    const headerEnd = body.indexOf(HEADER_SEPARATOR, cursor);
    if (headerEnd < 0) throw new MultipartError(400, 'malformed multipart headers');
    const headers = parseHeaders(body.subarray(cursor, headerEnd).toString('latin1'));
    const disposition = headers.get('content-disposition');
    const name = dispositionParameter(disposition, 'name');
    if (!name) throw new MultipartError(400, 'multipart field name is required');
    const filename = dispositionParameter(disposition, 'filename');
    const contentType = headers.get('content-type');
    const dataStart = headerEnd + HEADER_SEPARATOR.length;
    const nextBoundary = body.indexOf(delimiter, dataStart);
    if (nextBoundary < 0) throw new MultipartError(400, 'malformed multipart body');
    parts.push({
      name,
      ...(filename === undefined ? {} : { filename: sanitizeFilename(filename) }),
      ...(contentType === undefined ? {} : { contentType }),
      data: body.subarray(dataStart, nextBoundary),
    });
    cursor = nextBoundary + delimiter.length;
  }
  return parts;
}

function parseHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of text.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new MultipartError(400, 'malformed multipart headers');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!name || headers.has(name)) throw new MultipartError(400, 'malformed multipart headers');
    headers.set(name, value);
  }
  return headers;
}

function dispositionParameter(value: string | undefined, parameter: string): string | undefined {
  if (!value || !/^form-data(?:;|\s*$)/i.test(value)) return undefined;
  const expression = new RegExp(`(?:^|;)\\s*${parameter}=(?:"((?:\\\\.|[^"])*)"|([^;\\s]+))`, 'i');
  const match = expression.exec(value);
  const result = match?.[1] ?? match?.[2];
  return result?.replaceAll('\\"', '"').trim();
}

function sanitizeFilename(value: string): string {
  const filename = path.basename(value.replaceAll('\\', '/'));
  if (!filename || filename === '.' || filename === '..' || filename.includes('\0')) {
    throw new MultipartError(400, 'file filename is invalid');
  }
  return filename;
}
