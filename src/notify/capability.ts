import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  ApprovalEventKind,
  CapabilityTokenClaims,
  HmacKey,
  HmacKeyRing,
  MintCapabilityTokenOptions,
} from './types.js';
import type { NotifyStore } from './store.js';

const TOKEN_VERSION = 1 as const;
const DEFAULT_TTL_SECONDS = 10 * 60;

export interface CapabilityTokenManagerOptions {
  readonly keys: HmacKeyRing;
  readonly now?: () => Date;
  readonly default_ttl_seconds?: number;
}

export class CapabilityTokenManager {
  private readonly keys: HmacKeyRing;
  private readonly now: () => Date;
  private readonly defaultTtlSeconds: number;
  private readonly store: NotifyStore;

  public constructor(store: NotifyStore, options: CapabilityTokenManagerOptions) {
    this.store = store;
    this.keys = validateKeyRing(options.keys, 'capability');
    this.now = options.now ?? (() => new Date());
    this.defaultTtlSeconds = options.default_ttl_seconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(this.defaultTtlSeconds) || this.defaultTtlSeconds <= 0) {
      throw new Error('capability token TTL must be a positive integer');
    }
  }

  public mint(options: MintCapabilityTokenOptions): string {
    if (!options.proposal_id.trim()) throw new Error('proposal_id is required');
    if (!options.action.trim()) throw new Error('action is required');
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const ttl = options.expires_in_seconds ?? this.defaultTtlSeconds;
    if (!Number.isInteger(ttl) || ttl <= 0)
      throw new Error('token expiry must be a positive integer');
    const claims: CapabilityTokenClaims = {
      version: TOKEN_VERSION,
      token_id: randomUUID(),
      proposal_id: options.proposal_id,
      action: options.action,
      signature: options.signature ?? options.proposal_id,
      request_id: options.request_id ?? options.proposal_id,
      scope: options.scope ?? { proposal_id: options.proposal_id },
      approval_event: options.approval_event ?? defaultApprovalEvent(options.action),
      kid: this.keys.current.kid,
      issued_at: issuedAt,
      expires_at: issuedAt + ttl,
      nonce: randomBytes(18).toString('base64url'),
    };
    const encodedClaims = encodeClaims(claims);
    const token = `${encodedClaims}.${sign(encodedClaims, this.keys.current)}`;
    this.store.insertCapabilityToken(claims, hashToken(token), this.now().toISOString());
    return token;
  }

  public verify(token: string): CapabilityTokenClaims | undefined {
    const parsed = decodeToken(token);
    if (!parsed) return undefined;
    const key = keyFor(this.keys, parsed.claims.kid);
    if (!key || !validSignature(parsed.encodedClaims, parsed.signature, key)) return undefined;
    const now = Math.floor(this.now().getTime() / 1000);
    if (parsed.claims.expires_at <= now || parsed.claims.issued_at > now + 30) return undefined;
    const stored = this.store.capabilityToken(hashToken(token));
    if (!stored || stored.used_at || stored.revoked_at) return undefined;
    if (
      stored.token_id !== parsed.claims.token_id ||
      stored.proposal_id !== parsed.claims.proposal_id ||
      stored.action !== parsed.claims.action ||
      stored.kid !== parsed.claims.kid ||
      Date.parse(stored.expires_at) <= this.now().getTime()
    ) {
      return undefined;
    }
    return parsed.claims;
  }

  public consume(token: string): CapabilityTokenClaims | undefined {
    const claims = this.verify(token);
    if (!claims) return undefined;
    return this.store.claimCapabilityToken(hashToken(token), this.now().toISOString())
      ? claims
      : undefined;
  }

  public revoke(token: string): boolean {
    const claims = this.verify(token);
    if (!claims) return false;
    return this.store.revokeCapabilityToken(hashToken(token), this.now().toISOString());
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function validateKeyRing(keys: HmacKeyRing, label: string): HmacKeyRing {
  validateKey(keys.current, `${label} current`);
  if (keys.previous) validateKey(keys.previous, `${label} previous`);
  if (keys.previous && keys.previous.kid === keys.current.kid) {
    throw new Error(`${label} key ids must be distinct`);
  }
  return keys;
}

function validateKey(key: HmacKey, label: string): void {
  if (!key.kid.trim()) throw new Error(`${label} key id is required`);
  if (typeof key.secret === 'string' && key.secret.length === 0) {
    throw new Error(`${label} secret is required`);
  }
  if (key.secret instanceof Uint8Array && key.secret.length === 0) {
    throw new Error(`${label} secret is required`);
  }
}

function defaultApprovalEvent(action: string): ApprovalEventKind {
  return /proposal/i.test(action) ? 'proposal_approved' : 'action_approved';
}

function encodeClaims(claims: CapabilityTokenClaims): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

function sign(encodedClaims: string, key: HmacKey): string {
  return createHmac('sha256', key.secret).update(encodedClaims).digest('base64url');
}

function validSignature(encodedClaims: string, signature: string, key: HmacKey): boolean {
  const expected = Buffer.from(sign(encodedClaims, key));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

type DecodedToken = {
  readonly encodedClaims: string;
  readonly signature: string;
  readonly claims: CapabilityTokenClaims;
};

function decodeToken(token: string): DecodedToken | undefined {
  const pieces = token.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8'));
    if (!isClaims(value)) return undefined;
    return { encodedClaims: pieces[0], signature: pieces[1], claims: value };
  } catch {
    return undefined;
  }
}

function isClaims(value: unknown): value is CapabilityTokenClaims {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== TOKEN_VERSION ||
    typeof candidate.token_id !== 'string' ||
    typeof candidate.proposal_id !== 'string' ||
    typeof candidate.action !== 'string' ||
    typeof candidate.signature !== 'string' ||
    typeof candidate.request_id !== 'string' ||
    typeof candidate.kid !== 'string' ||
    typeof candidate.issued_at !== 'number' ||
    typeof candidate.expires_at !== 'number' ||
    typeof candidate.nonce !== 'string' ||
    (candidate.approval_event !== 'action_approved' &&
      candidate.approval_event !== 'proposal_approved')
  ) {
    return false;
  }
  if (!Number.isInteger(candidate.issued_at) || !Number.isInteger(candidate.expires_at))
    return false;
  if (!candidate.proposal_id || !candidate.action || !candidate.kid || !candidate.nonce)
    return false;
  if (!candidate.scope || typeof candidate.scope !== 'object' || Array.isArray(candidate.scope))
    return false;
  return Object.values(candidate.scope as Record<string, unknown>).every(
    (entry) => typeof entry === 'string',
  );
}

function keyFor(keys: HmacKeyRing, kid: string): HmacKey | undefined {
  if (kid === keys.current.kid) return keys.current;
  if (keys.previous?.kid === kid) return keys.previous;
  return undefined;
}
