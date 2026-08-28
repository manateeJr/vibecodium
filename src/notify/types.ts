import type { EventEnvelope, EventKind } from '../contracts/events.js';

export type NotificationSeverity = 'info' | 'warn' | 'action';
export type NotificationChannel = string;

export interface QuietHours {
  readonly start: string;
  readonly end: string;
  readonly timezone?: 'local' | 'UTC';
}

export interface NotifyRule {
  readonly event_kind: EventKind | '*';
  readonly severity: NotificationSeverity | '*';
  readonly channels: readonly NotificationChannel[];
  readonly enabled?: boolean;
}

export interface NotificationAction {
  readonly label: string;
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly clear?: boolean;
}

export interface NotificationMessage {
  readonly notification_id: string;
  readonly signature: string;
  readonly event_kind: EventKind;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly actions: readonly NotificationAction[];
}

export interface NotificationDelivery {
  readonly channel: string;
  readonly status: 'delivered' | 'failed' | 'skipped';
  readonly error?: string;
}

export interface Notifier {
  readonly name: string;
  send(message: NotificationMessage): Promise<NotificationDelivery | void>;
}

export interface NtfyNotifierOptions {
  readonly baseUrl?: string;
  readonly topic?: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface HmacKey {
  readonly kid: string;
  readonly secret: string | Uint8Array;
}

export interface HmacKeyRing {
  readonly current: HmacKey;
  readonly previous?: HmacKey;
}

export type ApprovalEventKind = 'action_approved' | 'proposal_approved';

export interface MintCapabilityTokenOptions {
  readonly proposal_id: string;
  readonly action: string;
  readonly signature?: string;
  readonly request_id?: string;
  readonly scope?: Readonly<Record<string, string>>;
  readonly approval_event?: ApprovalEventKind;
  readonly expires_in_seconds?: number;
}

export interface CapabilityTokenClaims {
  readonly version: 1;
  readonly token_id: string;
  readonly proposal_id: string;
  readonly action: string;
  readonly signature: string;
  readonly request_id: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly approval_event: ApprovalEventKind;
  readonly kid: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly nonce: string;
}

export interface InboundListenerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly max_body_bytes?: number;
  readonly timestamp_skew_seconds?: number;
  readonly public_base_url?: string;
}

export interface NotifyOptions {
  readonly dbPath?: string;
  readonly filename?: string;
  readonly defaultRules?: readonly NotifyRule[];
  readonly masterSwitch?: boolean;
  readonly quietHours?: QuietHours | null;
  readonly now?: () => Date;
  readonly notifiers?: Readonly<Record<string, Notifier>>;
  readonly ntfy?: NtfyNotifierOptions;
  readonly capabilityKeys?: HmacKeyRing;
  readonly inboxKeys?: HmacKeyRing;
  readonly capabilityTokenTtlSeconds?: number;
  readonly inbound?: InboundListenerOptions;
}

export interface InboundCapabilityCommand {
  readonly type: 'capability';
  readonly token: string;
  readonly decision?: 'approve' | 'reject';
  readonly stream_id?: string;
  readonly reason?: string;
  readonly source?: string;
}

export interface InboundInboxCommand {
  readonly type: 'inbox';
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly stream_id?: string;
  readonly source?: string;
}

export type InboundCommand = InboundCapabilityCommand | InboundInboxCommand;

export interface InboundResult {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly event_sequences?: readonly number[];
  readonly capability_token_id?: string;
}

export type NotifyEvent = EventEnvelope;
export type NotifyEventKind = EventKind;
