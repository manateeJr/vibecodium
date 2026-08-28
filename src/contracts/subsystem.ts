import type { EventEnvelope, EventKind, EventPayload } from './events.js';

export type EventHandler = (event: EventEnvelope) => void;

export type CommandHandler = (command: unknown) => unknown | Promise<unknown>;

export interface SubsystemContext {
  registerProjector(name: string, onEvent: EventHandler): void;
  registerCommand(name: string, handler: CommandHandler): void;
  registerListener(name: string, handler: EventHandler): void;
  append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number;
  subscribe(stream_id: string, from_seq: number, onEvent: EventHandler): () => void;
}

export type Subsystem = {
  name: string;
  register(ctx: SubsystemContext): void;
};
