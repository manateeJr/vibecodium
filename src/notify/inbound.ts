import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NotifyStore } from './store.js';
import type {
  HmacKey,
  HmacKeyRing,
  InboundCommand,
  InboundListenerOptions,
  InboundResult,
} from './types.js';
import { validateKeyRing } from './capability.js';

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export interface InboxVerifierOptions {
  readonly keys: HmacKeyRing;
  readonly now?: () => Date;
  readonly timestamp_skew_seconds?: number;
}

export interface InboundAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export type InboundCommandHandler = (command: InboundCommand) => Promise<InboundResult>;

export class InboxVerifier {
  private readonly store: NotifyStore;
  private readonly keys: HmacKeyRing;
  private readonly now: () => Date;
  private readonly skewSeconds: number;

  public constructor(store: NotifyStore, options: InboxVerifierOptions) {
    this.store = store;
    this.keys = validateKeyRing(options.keys, 'inbox');
    this.now = options.now ?? (() => new Date());
    this.skewSeconds = options.timestamp_skew_seconds ?? DEFAULT_TIMESTAMP_SKEW_SECONDS;
    if (!Number.isInteger(this.skewSeconds) || this.skewSeconds <= 0) {
      throw new Error('inbox timestamp skew must be a positive integer');
    }
  }

  public verify(
    body: string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): boolean {
    const kid = header(headers, 'x-vibecodium-kid', 'x-notify-kid', 'x-inbox-kid');
    const timestamp = header(
      headers,
      'x-vibecodium-timestamp',
      'x-notify-timestamp',
      'x-inbox-timestamp',
    );
    const signature = header(
      headers,
      'x-vibecodium-signature',
      'x-notify-signature',
      'x-inbox-signature',
    );
    if (!kid || !timestamp || !signature) return false;
    const key = keyFor(this.keys, kid);
    if (!key) return false;
    const timestampMs = parseTimestamp(timestamp);
    if (timestampMs === undefined) return false;
    if (Math.abs(this.now().getTime() - timestampMs) > this.skewSeconds * 1000) return false;
    if (!validSignature(body, timestamp, signature, key)) return false;
    const replayKey = createHash('sha256')
      .update(`${kid}\u0000${timestamp}\u0000${body}`)
      .digest('hex');
    const now = this.now();
    const retainAfter = new Date(now.getTime() - this.skewSeconds * 2 * 1000).toISOString();
    return this.store.rememberReplay(replayKey, now.toISOString(), retainAfter);
  }
}

export function signInboxRequest(body: string, timestamp: number | string, key: HmacKey): string {
  const rawTimestamp = String(timestamp);
  return createHmac('sha256', key.secret).update(`${rawTimestamp}.${body}`).digest('base64url');
}

export function isSafeInboundHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (!value || value === '0.0.0.0' || value === '::' || value === '[::]') return false;
  if (value === 'localhost' || value === '127.0.0.1' || value === '::1') return true;
  if (isTailnetIpv4(value)) return true;
  return isTailnetIpv6(value);
}

export class InboundListener {
  private readonly handler: InboundCommandHandler;
  private readonly host: string;
  private readonly port: number;
  private readonly maxBodyBytes: number;
  private readonly server: Server;
  private addressValue: InboundAddress | undefined;

  public constructor(handler: InboundCommandHandler, options: InboundListenerOptions = {}) {
    this.handler = handler;
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.maxBodyBytes = options.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
    if (!isSafeInboundHost(this.host)) {
      throw new Error('inbound listener must bind to localhost or a Tailscale tailnet address');
    }
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535) {
      throw new Error('inbound listener port must be between 0 and 65535');
    }
    if (!Number.isInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0) {
      throw new Error('inbound listener body limit must be positive');
    }
    this.server = createServer((request, response) => this.handle(request, response));
  }

  public async start(): Promise<InboundAddress> {
    if (this.addressValue) return this.addressValue;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('inbound listener address unavailable');
    const info = address as AddressInfo;
    this.addressValue = {
      host: this.host,
      port: info.port,
      url: `http://${this.host}:${info.port}`,
    };
    return this.addressValue;
  }

  public async stop(): Promise<void> {
    if (!this.addressValue) return;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.addressValue = undefined;
  }

  public address(): InboundAddress | undefined {
    return this.addressValue;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'POST') {
      sendJson(response, 405, { accepted: false, reason: 'method_not_allowed' });
      return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    void readBody(request, this.maxBodyBytes)
      .then((body) => this.dispatch(requestUrl, body, request.headers, response))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'invalid_request';
        sendJson(response, 400, { accepted: false, reason });
      });
  }

  private async dispatch(
    requestUrl: URL,
    body: string,
    headers: IncomingHttpHeaders,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = requestUrl.pathname;
    let command: InboundCommand;
    try {
      if (pathname === '/notify/capability' || pathname === '/capability') {
        const parsed: unknown = body.trim() ? JSON.parse(body) : {};
        command = capabilityCommand(parsed, requestUrl.searchParams);
      } else if (pathname === '/notify/inbox' || pathname === '/inbox') {
        command = {
          type: 'inbox',
          body,
          headers,
        };
      } else {
        sendJson(response, 404, { accepted: false, reason: 'not_found' });
        return;
      }
    } catch {
      sendJson(response, 400, { accepted: false, reason: 'invalid_json' });
      return;
    }
    const result = await this.handler(command);
    sendJson(response, result.accepted ? 200 : 401, result);
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function capabilityCommand(value: unknown, searchParams?: URLSearchParams): InboundCommand {
  if (!value || typeof value !== 'object') throw new Error('capability body must be an object');
  const candidate = value as Record<string, unknown>;
  const token = typeof candidate.token === 'string' ? candidate.token : searchParams?.get('token');
  if (!token) throw new Error('token is required');
  const queryDecision = searchParams?.get('decision') ?? undefined;
  const decision = candidate.decision ?? queryDecision;
  if (decision !== undefined && decision !== 'approve' && decision !== 'reject') {
    throw new Error('decision must be approve or reject');
  }
  const command: InboundCommand = {
    type: 'capability',
    token,
    ...(decision === undefined ? {} : { decision }),
    ...(typeof candidate.stream_id === 'string' ? { stream_id: candidate.stream_id } : {}),
    ...(typeof candidate.reason === 'string' ? { reason: candidate.reason } : {}),
    ...(typeof candidate.source === 'string' ? { source: candidate.source } : {}),
  };
  return command;
}

function header(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  ...names: string[]
): string | undefined {
  const normalized = new Map<string, string | string[] | undefined>();
  for (const [name, value] of Object.entries(headers)) normalized.set(name.toLowerCase(), value);
  for (const name of names) {
    const value = normalized.get(name);
    if (Array.isArray(value)) return value[0];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function parseTimestamp(raw: string): number | undefined {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return undefined;
  const timestampMs = Math.abs(numeric) > 1e12 ? numeric : numeric * 1000;
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function validSignature(body: string, timestamp: string, signature: string, key: HmacKey): boolean {
  const expected = createHmac('sha256', key.secret).update(`${timestamp}.${body}`).digest();
  const actual = decodeSignature(signature);
  return (
    actual !== undefined && actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}

function decodeSignature(value: string): Buffer | undefined {
  try {
    if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
    if (/^[A-Za-z0-9_-]+$/.test(value)) return Buffer.from(value, 'base64url');
  } catch {
    return undefined;
  }
  return undefined;
}

function keyFor(keys: HmacKeyRing, kid: string): HmacKey | undefined {
  if (kid === keys.current.kid) return keys.current;
  if (keys.previous?.kid === kid) return keys.previous;
  return undefined;
}

function isTailnetIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const [first, second] = parts.map(Number);
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

function isTailnetIpv6(value: string): boolean {
  const normalized = value.replace(/^\[/, '').replace(/\]$/, '');
  return normalized === 'fd7a:115c:a1e0' || normalized.startsWith('fd7a:115c:a1e0:');
}
