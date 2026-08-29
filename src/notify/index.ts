import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../contracts/events.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { CapabilityTokenManager } from './capability.js';
import {
  InboxVerifier,
  InboundListener,
  type InboundAddress,
  isSafeInboundHost,
  signInboxRequest,
} from './inbound.js';
import { NtfyNotifier } from './notifier.js';
import { NotifyStore, type NotifyLogRow } from './store.js';
import {
  asRecord,
  asStringRecord,
  capabilityActions,
  databasePath,
  defaultKeyRing,
  inQuietHours,
  isInboundCommand,
  normalizeInboundBaseUrl,
  notificationSignature,
  parseQuietHours,
  parseRule,
  severityFor,
  stringOr,
  validateQuietHours,
  validateRule,
} from './helpers.js';
import type {
  CapabilityTokenClaims,
  HmacKey,
  HmacKeyRing,
  InboundCommand,
  InboundResult,
  MintCapabilityTokenOptions,
  NotificationAction,
  NotificationMessage,
  NotificationSeverity,
  Notifier,
  NotifyOptions,
  NotifyRule,
  QuietHours,
} from './types.js';

export {
  CapabilityTokenManager,
  InboxVerifier,
  InboundListener,
  NtfyNotifier,
  NotifyStore,
  isSafeInboundHost,
  signInboxRequest,
};
export type {
  CapabilityTokenClaims,
  HmacKey,
  HmacKeyRing,
  InboundAddress,
  InboundCommand,
  InboundResult,
  MintCapabilityTokenOptions,
  NotificationAction,
  NotificationMessage,
  NotificationSeverity,
  Notifier,
  NotifyOptions,
  NotifyRule,
  QuietHours,
};

export const DEFAULT_NOTIFY_RULES: readonly NotifyRule[] = [
  { event_kind: 'action_requested', severity: 'action', channels: ['ntfy', 'in-app'] },
  { event_kind: 'action_denied', severity: 'action', channels: ['ntfy', 'in-app'] },
  { event_kind: 'verify_failed', severity: 'warn', channels: ['ntfy', 'in-app'] },
  { event_kind: 'turn_complete', severity: 'info', channels: ['ntfy'] },
  { event_kind: 'proposal_queued', severity: 'info', channels: ['in-app'] },
  { event_kind: 'proposal_approved', severity: 'info', channels: ['in-app'] },
  { event_kind: 'merge_to_main', severity: 'info', channels: ['in-app'] },
];

function notificationText(event: EventEnvelope): { readonly title: string; readonly body: string } {
  if (event.type === 'turn_complete') {
    return { title: 'omp turn done', body: `stream ${event.stream_id}` };
  }
  if (event.type === 'verify_failed') {
    const payload = asRecord(event.payload);
    const error = typeof payload?.error === 'string' ? payload.error : 'unknown error';
    return { title: 'omp verify failed', body: error.slice(0, 240) };
  }
  return {
    title: event.type.replaceAll('_', ' '),
    body: JSON.stringify(event.payload),
  };
}

function isNtfyConfigured(options: NotifyOptions): boolean {
  if (options.notifiers?.ntfy !== undefined) return true;
  const baseUrl = options.ntfy?.baseUrl ?? process.env.VIBECODIUM_NTFY_URL;
  const topic =
    options.ntfy?.topic ??
    process.env.VIBECODIUM_NTFY_TOPIC ??
    (options.ntfy?.baseUrl !== undefined ? 'vibecodium' : undefined);
  return Boolean(baseUrl && topic && !/[\r\n]/.test(topic));
}

const DEFAULT_INBOUND_BASE_URL = 'http://127.0.0.1:4311';

export class NotifySubsystem implements Subsystem {
  public readonly name = 'notify';
  public readonly store: NotifyStore;
  public readonly capabilityTokens: CapabilityTokenManager;
  public readonly inboxVerifier: InboxVerifier;
  public readonly inboundListener: InboundListener;
  private readonly now: () => Date;
  private readonly ntfyConfigured: boolean;
  private readonly inboundBaseUrl: string;
  private readonly notifiers: Readonly<Record<string, Notifier>>;
  private context: SubsystemContext | undefined;
  private registered = false;

  public constructor(options: NotifyOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ntfyConfigured = isNtfyConfigured(options);
    this.store = new NotifyStore({ filename: databasePath(options) });
    for (const rule of options.defaultRules ?? DEFAULT_NOTIFY_RULES) this.setRule(rule);
    if (options.masterSwitch !== undefined) this.store.setMasterSwitch(options.masterSwitch);
    if (options.quietHours !== undefined) this.setQuietHours(options.quietHours);
    const defaultNotifier = new NtfyNotifier(options.ntfy);
    this.notifiers = { ntfy: defaultNotifier, ...(options.notifiers ?? {}) };
    const capabilityKeys =
      options.capabilityKeys ?? defaultKeyRing('VIBECODIUM_CAPABILITY', 'capability-v1');
    const inboxKeys = options.inboxKeys ?? defaultKeyRing('VIBECODIUM_INBOX', 'inbox-v1');
    this.capabilityTokens = new CapabilityTokenManager(this.store, {
      keys: capabilityKeys,
      now: this.now,
      ...(options.capabilityTokenTtlSeconds === undefined
        ? {}
        : { default_ttl_seconds: options.capabilityTokenTtlSeconds }),
    });
    this.inboxVerifier = new InboxVerifier(this.store, {
      keys: inboxKeys,
      now: this.now,
      ...(options.inbound?.timestamp_skew_seconds === undefined
        ? {}
        : { timestamp_skew_seconds: options.inbound.timestamp_skew_seconds }),
    });
    this.inboundListener = new InboundListener(
      (command) => this.handleInbound(command),
      options.inbound,
    );
    this.inboundBaseUrl = normalizeInboundBaseUrl(
      options.inbound?.public_base_url ??
        process.env.VIBECODIUM_INBOUND_BASE_URL ??
        DEFAULT_INBOUND_BASE_URL,
    );
  }

  public register(ctx: SubsystemContext): void {
    if (this.registered) throw new Error('notify subsystem is already registered');
    this.registered = true;
    this.context = ctx;
    ctx.registerListener('notify-router', (event) => this.handleEvent(event));
    ctx.registerCommand('notify.inbound', (command) => this.handleInbound(command));
    ctx.registerCommand('notify.rules', (command) => this.handleRulesCommand(command));
  }

  public setRule(rule: NotifyRule): void {
    validateRule(rule);
    this.store.setRule(rule, this.now().toISOString());
  }

  public removeRule(event_kind: string, severity: string): boolean {
    return this.store.removeRule(event_kind, severity);
  }

  public rules(): NotifyRule[] {
    return this.store.rules();
  }

  public masterSwitch(): boolean {
    return this.store.getMasterSwitch();
  }

  public setMasterSwitch(enabled: boolean): void {
    this.store.setMasterSwitch(enabled);
  }

  public quietHours(): QuietHours | null {
    return this.store.getQuietHours();
  }

  public setQuietHours(quietHours: QuietHours | null): void {
    if (quietHours) validateQuietHours(quietHours);
    this.store.setQuietHours(quietHours);
  }

  public notifications(): NotifyLogRow[] {
    return this.store.notifications();
  }

  public mintCapabilityToken(options: MintCapabilityTokenOptions): string {
    return this.capabilityTokens.mint(options);
  }

  public verifyCapabilityToken(token: string): CapabilityTokenClaims | undefined {
    return this.capabilityTokens.verify(token);
  }

  public consumeCapabilityToken(token: string): CapabilityTokenClaims | undefined {
    return this.capabilityTokens.consume(token);
  }

  public async startInbound(): Promise<InboundAddress> {
    return this.inboundListener.start();
  }

  public async stopInbound(): Promise<void> {
    await this.inboundListener.stop();
  }

  public async close(): Promise<void> {
    await this.stopInbound();
    this.store.close();
  }

  public async handleInbound(command: unknown): Promise<InboundResult> {
    if (!isInboundCommand(command)) return { accepted: false, reason: 'invalid_inbound_command' };
    if (command.type === 'capability') return this.handleCapability(command);
    return this.handleInbox(command);
  }

  private handleEvent(event: EventEnvelope): void {
    if (event.type === 'notify_emitted' || !this.store.getMasterSwitch()) return;
    const severity = severityFor(event);
    if (severity !== 'action' && inQuietHours(this.now(), this.store.getQuietHours())) return;
    const channels = this.store
      .route(event.type, severity)
      .filter((channel) => channel !== 'ntfy' || this.ntfyConfigured);
    if (channels.length === 0) return;
    const signature = notificationSignature(event, severity);
    const { title, body } = notificationText(event);
    const record = this.store.recordNotification({
      notification_id: randomUUID(),
      signature,
      stream_id: event.stream_id,
      event_seq: event.seq,
      event_kind: event.type,
      severity,
      channels,
      title,
      body,
      now: this.now().toISOString(),
    });
    if (!record.first) return;
    const message: NotificationMessage = {
      notification_id: record.row.notification_id,
      signature,
      event_kind: event.type,
      severity,
      title,
      body,
      actions: this.actionsFor(event),
    };
    const context = this.context;
    if (!context) return;
    try {
      context.append(event.stream_id, 'notify_emitted', {
        notification_id: message.notification_id,
        channels,
        severity,
      });
    } catch {
      this.store.markNotification(
        message.notification_id,
        'failed',
        this.now().toISOString(),
        'event_append_failed',
      );
      return;
    }
    void this.deliver(message, channels);
  }

  private actionsFor(event: EventEnvelope): readonly NotificationAction[] {
    const payload = asRecord(event.payload) ?? {};
    if (event.type === 'action_requested') {
      const scope = asStringRecord(payload.scope);
      const proposalId = scope?.proposal_id;
      if (!proposalId) return [];
      const selfVerify = payload.self_verify;
      if (selfVerify !== undefined && selfVerify !== 'passed') return [];
      const token = this.capabilityTokens.mint({
        proposal_id: proposalId,
        action: typeof payload.action === 'string' ? payload.action : 'approve',
        request_id: typeof payload.request_id === 'string' ? payload.request_id : proposalId,
        ...(scope === undefined ? {} : { scope }),
        approval_event: 'action_approved',
      });
      return capabilityActions(token, this.inboundBaseUrl);
    }
    if (event.type !== 'proposal_queued' || payload.self_verify !== 'passed') return [];
    if (typeof payload.proposal_id !== 'string' || typeof payload.signature !== 'string') return [];
    const token = this.capabilityTokens.mint({
      proposal_id: payload.proposal_id,
      signature: payload.signature,
      action: 'approve_proposal',
      approval_event: 'proposal_approved',
    });
    return capabilityActions(token, this.inboundBaseUrl);
  }

  private async deliver(message: NotificationMessage, channels: readonly string[]): Promise<void> {
    let delivered = false;
    let attempted = false;
    let lastError = 'no notifier configured';
    for (const channel of channels) {
      const notifier =
        this.notifiers[channel] ?? (channel === 'phone' ? this.notifiers.ntfy : undefined);
      if (!notifier) continue;
      attempted = true;
      try {
        const result = await notifier.send(message);
        if (!result || result.status === 'delivered') delivered = true;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    const status = delivered ? 'delivered' : 'failed';
    const reason = attempted ? lastError : 'no notifier configured';
    this.store.markNotification(message.notification_id, status, this.now().toISOString(), reason);
  }

  private async handleCapability(
    command: Extract<InboundCommand, { type: 'capability' }>,
  ): Promise<InboundResult> {
    const context = this.context;
    if (!context) return { accepted: false, reason: 'notify_subsystem_not_registered' };
    const claims = this.capabilityTokens.consume(command.token);
    if (!claims) return { accepted: false, reason: 'invalid_expired_or_replayed_token' };
    const streamId = command.stream_id ?? 'notify';
    const source = command.source ?? 'capability';
    const sequences = [this.appendInbound(streamId, source, claims.request_id, claims.token_id)];
    if ((command.decision ?? 'approve') === 'reject') {
      sequences.push(
        context.append(streamId, 'action_denied', {
          request_id: claims.request_id,
          action: claims.action,
          scope: claims.scope,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        }),
      );
    } else if (claims.approval_event === 'proposal_approved') {
      sequences.push(
        context.append(streamId, 'proposal_approved', {
          proposal_id: claims.proposal_id,
          signature: claims.signature,
        }),
      );
    } else {
      sequences.push(
        context.append(streamId, 'action_approved', {
          request_id: claims.request_id,
          action: claims.action,
          scope: claims.scope,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        }),
      );
    }
    return {
      accepted: true,
      event_sequences: sequences,
      capability_token_id: claims.token_id,
    };
  }

  private async handleInbox(
    command: Extract<InboundCommand, { type: 'inbox' }>,
  ): Promise<InboundResult> {
    if (!this.inboxVerifier.verify(command.body, command.headers)) {
      return { accepted: false, reason: 'invalid_expired_or_replayed_hmac' };
    }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(command.body);
      const record = asRecord(parsed);
      if (!record) return { accepted: false, reason: 'inbox_body_must_be_object' };
      payload = record;
    } catch {
      return { accepted: false, reason: 'inbox_body_must_be_json' };
    }
    const streamId = command.stream_id ?? stringOr(payload.stream_id, 'inbox') ?? 'inbox';
    const source = command.source ?? stringOr(payload.source, 'custom-inbox') ?? 'custom-inbox';
    const requestId = stringOr(payload.request_id, undefined);
    const sequence = this.appendInbound(streamId, source, requestId, undefined);
    return { accepted: true, event_sequences: [sequence] };
  }

  private appendInbound(
    stream_id: string,
    source: string,
    request_id: string | undefined,
    capability_token_id: string | undefined,
  ): number {
    if (!this.context) throw new Error('notify subsystem is not registered');
    return this.context.append(stream_id, 'inbound_received', {
      source,
      ...(request_id === undefined ? {} : { request_id }),
      ...(capability_token_id === undefined ? {} : { capability_token_id }),
    });
  }

  private async handleRulesCommand(command: unknown): Promise<unknown> {
    const value = asRecord(command);
    if (!value || typeof value.op !== 'string')
      return { ok: false, reason: 'invalid_rules_command' };
    if (value.op === 'list') return { ok: true, rules: this.rules() };
    if (value.op === 'set') {
      const rule = parseRule(value.rule);
      if (!rule) return { ok: false, reason: 'invalid_rule' };
      this.setRule(rule);
      return { ok: true, rule };
    }
    if (
      value.op === 'remove' &&
      typeof value.event_kind === 'string' &&
      typeof value.severity === 'string'
    ) {
      return { ok: this.removeRule(value.event_kind, value.severity) };
    }
    if (value.op === 'master' && typeof value.enabled === 'boolean') {
      this.setMasterSwitch(value.enabled);
      return { ok: true, enabled: value.enabled };
    }
    if (value.op === 'quiet_hours') {
      const parsedQuietHours =
        value.quiet_hours === null ? null : parseQuietHours(value.quiet_hours);
      if (value.quiet_hours !== null && !parsedQuietHours)
        return { ok: false, reason: 'invalid_quiet_hours' };
      const quietHours = parsedQuietHours ?? null;
      this.setQuietHours(quietHours);
      return { ok: true, quiet_hours: quietHours };
    }
    return { ok: false, reason: 'unknown_rules_operation' };
  }
}

export function createNotifySubsystem(options: NotifyOptions = {}): NotifySubsystem {
  return new NotifySubsystem(options);
}

export function register(ctx: SubsystemContext): void {
  createNotifySubsystem().register(ctx);
}
