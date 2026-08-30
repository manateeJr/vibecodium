import type { SessionTable } from './session-table.js';
import type { SubstrateClient, SubstrateOutputChunk } from '../contracts/substrate-contract.js';

export const PTY_OUTPUT_BUFFER_SIZE = 64 * 1024;

type PtyListener = (data: Uint8Array) => void;
type SubstrateNameResolver = (sessionId: string) => string | undefined;

type PtySubscription = {
  readonly listener: PtyListener;
  readonly pending: Uint8Array[];
  replaying: boolean;
};

type SessionBuffer = {
  readonly listeners: Set<PtySubscription>;
  readonly output: ByteRingBuffer;
};

class ByteRingBuffer {
  private readonly bytes = new Uint8Array(PTY_OUTPUT_BUFFER_SIZE);
  private start = 0;
  private length = 0;

  public append(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    if (data.byteLength >= this.bytes.byteLength) {
      this.bytes.set(data.subarray(data.byteLength - this.bytes.byteLength));
      this.start = 0;
      this.length = this.bytes.byteLength;
      return;
    }
    const discarded = Math.max(0, this.length + data.byteLength - this.bytes.byteLength);
    this.start = (this.start + discarded) % this.bytes.byteLength;
    this.length -= discarded;
    const writeOffset = (this.start + this.length) % this.bytes.byteLength;
    const firstLength = Math.min(data.byteLength, this.bytes.byteLength - writeOffset);
    this.bytes.set(data.subarray(0, firstLength), writeOffset);
    if (firstLength < data.byteLength) this.bytes.set(data.subarray(firstLength), 0);
    this.length += data.byteLength;
  }

  public snapshot(): Uint8Array {
    if (this.length === 0) return new Uint8Array();
    const snapshot = new Uint8Array(this.length);
    const firstLength = Math.min(this.length, this.bytes.byteLength - this.start);
    snapshot.set(this.bytes.subarray(this.start, this.start + firstLength));
    if (firstLength < this.length) {
      snapshot.set(this.bytes.subarray(0, this.length - firstLength), firstLength);
    }
    return snapshot;
  }
}

export class PtySubscriptionHub {
  private readonly sessions = new Map<string, SessionBuffer>();
  private outputUnsubscribe: (() => void) | undefined;
  private subscriberCount = 0;

  public constructor(
    private readonly substrate: SubstrateClient | undefined,
    private readonly resolveSubstrateName: SubstrateNameResolver,
  ) {}

  public subscribe(sessionId: string, listener: PtyListener): () => void {
    if (!sessionId.trim()) return () => undefined;
    const session = this.sessions.get(sessionId) ?? {
      listeners: new Set<PtySubscription>(),
      output: new ByteRingBuffer(),
    };
    this.sessions.set(sessionId, session);
    const buffered = session.output.snapshot();
    const subscription: PtySubscription = { listener, pending: [], replaying: true };
    session.listeners.add(subscription);
    this.subscriberCount += 1;
    this.ensureOutputListener();
    try {
      if (buffered.byteLength > 0) listener(buffered);
      while (subscription.pending.length > 0) {
        const pending = subscription.pending.splice(0);
        for (const data of pending) listener(data);
      }
    } finally {
      subscription.replaying = false;
      subscription.pending.length = 0;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!session.listeners.delete(subscription)) return;
      this.subscriberCount -= 1;
      if (this.subscriberCount === 0) this.releaseOutputListener();
      if (session.listeners.size === 0 && !this.hasSubstrateName(sessionId)) {
        this.sessions.delete(sessionId);
      }
    };
  }

  private ensureOutputListener(): void {
    if (this.outputUnsubscribe !== undefined || this.substrate === undefined) return;
    this.outputUnsubscribe = this.substrate.onOutput((chunk) => this.handleOutput(chunk));
  }

  private releaseOutputListener(): void {
    this.outputUnsubscribe?.();
    this.outputUnsubscribe = undefined;
  }

  private handleOutput(chunk: SubstrateOutputChunk): void {
    for (const [sessionId, session] of this.sessions) {
      if (this.safeResolveSubstrateName(sessionId) !== chunk.name) continue;
      session.output.append(chunk.data);
      for (const subscription of session.listeners) {
        if (subscription.replaying) subscription.pending.push(chunk.data);
        else subscription.listener(chunk.data);
      }
    }
  }

  private hasSubstrateName(sessionId: string): boolean {
    return this.safeResolveSubstrateName(sessionId) !== undefined;
  }

  private safeResolveSubstrateName(sessionId: string): string | undefined {
    try {
      return this.resolveSubstrateName(sessionId);
    } catch {
      return undefined;
    }
  }
}

export function createPtySubscription(
  substrate: SubstrateClient | undefined,
  sessionTable: SessionTable | undefined,
): PtySubscriptionHub['subscribe'] {
  const hub = new PtySubscriptionHub(
    substrate,
    (sessionId) => sessionTable?.get(sessionId)?.substrateName,
  );
  return hub.subscribe.bind(hub);
}
