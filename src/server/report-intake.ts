import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { REPORT_MAX_INTAKE_BYTES, type ReportRecord } from '../contracts/report-commands.js';
import { MultipartError, parseMultipartParts, type MultipartPart } from './multipart.js';
import { bearerToken, isLoopbackAddress } from './control-plane-helpers.js';
import {
  normalizeEnvelope,
  type ReportAttachmentInput,
  type ReportStore,
} from '../reports/store.js';

export interface ReportIntakeOptions {
  readonly store: ReportStore;
  readonly onCreated?: (record: ReportRecord) => void;
  readonly verifyToken?: (token: string | undefined) => boolean;
  readonly maxBytes?: number;
}

export async function handleReportIntake(
  request: IncomingMessage,
  response: ServerResponse,
  options: ReportIntakeOptions,
): Promise<void> {
  try {
    if (
      !isLoopbackAddress(request.socket.remoteAddress) &&
      options.verifyToken?.(bearerToken(request.headers.authorization)) !== true
    ) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const maxBytes = options.maxBytes ?? REPORT_MAX_INTAKE_BYTES;
    const contentType = headerValue(request.headers['content-type']);
    const input = isMultipartContentType(contentType)
      ? await multipartInput(request, maxBytes)
      : { payload: await jsonBody(request, maxBytes), attachments: [] };
    const record = await options.store.create(
      normalizeEnvelope(input.payload, new Date()),
      input.attachments,
    );
    options.onCreated?.(record);
    sendJson(response, 200, {
      id: record.id,
      path: path.dirname(options.store.bodyPath(record.id)),
    });
  } catch (error: unknown) {
    if (error instanceof MultipartError) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function multipartInput(
  request: IncomingMessage,
  maxBytes: number,
): Promise<{ readonly payload: unknown; readonly attachments: readonly ReportAttachmentInput[] }> {
  const parts = await parseMultipartParts(request, maxBytes);
  const envelopePart = parts.find((part) => part.name === 'envelope');
  const payload = envelopePart
    ? parseJsonPart(envelopePart, 'envelope must be valid JSON')
    : parseBarePart(parts);
  const attachments = parts
    .filter(
      (part) =>
        part.name === 'attachments' || (part.filename !== undefined && part.name !== 'envelope'),
    )
    .map(toAttachment);
  return { payload, attachments };
}

function parseBarePart(parts: readonly MultipartPart[]): unknown {
  const barePart = parts.find((part) => part.filename === undefined);
  if (!barePart) throw new MultipartError(400, 'envelope part is required');
  return parseJsonPart(barePart, 'request body must be valid JSON');
}

function parseJsonPart(part: MultipartPart, message: string): unknown {
  try {
    return JSON.parse(part.data.toString('utf8')) as unknown;
  } catch {
    throw new MultipartError(400, message);
  }
}

function toAttachment(part: MultipartPart): ReportAttachmentInput {
  if (part.filename === undefined) {
    throw new MultipartError(400, 'attachment filename is required');
  }
  return {
    filename: part.filename,
    data: part.data,
    ...(part.contentType === undefined ? {} : { contentType: part.contentType }),
  };
}

async function jsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += data.byteLength;
    if (total > maxBytes) throw new MultipartError(413, 'request body exceeds intake limit');
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
  } catch {
    throw new MultipartError(400, 'request body must be valid JSON');
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isMultipartContentType(contentType: string | undefined): boolean {
  return /^multipart\/form-data(?:\s*;|\s*$)/i.test(contentType ?? '');
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
  });
  response.end(body);
}
