import type { EventKind } from './events.js';

export const TELEMETRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  stage TEXT,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL,
  UNIQUE (stream_id, seq)
);
CREATE INDEX IF NOT EXISTS events_kind_stage ON events (kind, stage);

CREATE TABLE IF NOT EXISTS signatures (
  signature TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('open', 'proposed', 'resolved', 'ignored')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'approved', 'rejected', 'installed')),
  artifact_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS proposals_signature ON proposals (signature);

CREATE TABLE IF NOT EXISTS capability_tokens (
  token_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  kid TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capability_tokens_proposal ON capability_tokens (proposal_id);
`;

export interface TelemetryEventRow {
  readonly id: number;
  readonly stream_id: string;
  readonly seq: number;
  readonly kind: EventKind;
  readonly stage: string | null;
  readonly payload: string;
  readonly ts: string;
}

export type SignatureStatus = 'open' | 'proposed' | 'resolved' | 'ignored';

export interface TelemetrySignatureRow {
  readonly signature: string;
  readonly kind: EventKind;
  readonly stage: string;
  readonly occurrences: number;
  readonly status: SignatureStatus;
  readonly updated_at: string;
}

export type ProposalStatus = 'queued' | 'approved' | 'rejected' | 'installed';

export interface TelemetryProposalRow {
  readonly proposal_id: string;
  readonly signature: string;
  readonly kind: EventKind;
  readonly stage: string;
  readonly status: ProposalStatus;
  readonly artifact_path: string;
  readonly created_at: string;
  readonly approved_at: string | null;
}

export interface CapabilityTokenRow {
  readonly token_id: string;
  readonly proposal_id: string;
  readonly action: string;
  readonly kid: string;
  readonly token_hash: string;
  readonly expires_at: string;
  readonly used_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}
