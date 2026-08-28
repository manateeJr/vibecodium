import type { EventEnvelope, EventKind, EventPayload } from './events.js';

export type EventHandler = (event: EventEnvelope) => void;

export type CommandHandler = (command: unknown) => unknown | Promise<unknown>;

export interface SubsystemContext {
  /**
   * Register a global read-model projector. Existing events after this named
   * projector's durable cursor are replayed, then new events are delivered
   * across every stream. The cursor advances only after onEvent returns.
   * Pass 0 to rebuild from the beginning.
   */
  registerProjector(name: string, onEvent: EventHandler, from_seq?: number): void;
  registerCommand(name: string, handler: CommandHandler): void;
  /** Register a live-only reactor for side effects; it never replays history. */
  registerListener(name: string, handler: EventHandler): void;
  append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number;
  /** Subscribe to the global event log after a sequence cursor. */
  subscribe(from_seq: number, onEvent: EventHandler): () => void;
}

export type Subsystem = {
  name: string;
  register(ctx: SubsystemContext): void;
};
