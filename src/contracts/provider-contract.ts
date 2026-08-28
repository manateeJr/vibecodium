import type { SessionOutputPayload } from './events.js';

export interface ProviderSpawnRequest {
  readonly sessionId: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly storageDir?: string;
  readonly resume?: boolean;
}

export interface ProviderSession {
  readonly id: string;
  readonly request: ProviderSpawnRequest;
  stopped: boolean;
}

export interface ProviderChunk {
  readonly index: number;
  readonly text: string;
}

export interface ProviderCapabilityMatrix {
  readonly provider: string;
  readonly streaming: boolean;
  readonly stop: boolean;
  readonly models: readonly string[];
}

export interface ProviderSessionRef {
  readonly name: string;
  spawn(request: ProviderSpawnRequest): Promise<ProviderSession>;
  stream(session: ProviderSession): AsyncIterable<ProviderChunk>;
  stop(session: ProviderSession): Promise<void>;
  capabilityMatrix(): ProviderCapabilityMatrix;
}

export interface ProviderOutputEvent {
  readonly type: 'session_output';
  readonly payload: SessionOutputPayload;
}

export interface ProviderOutputEventInput {
  readonly session_id: string;
  readonly chunk: ProviderChunk;
}

export type ProviderOutputEventMapper = (input: ProviderOutputEventInput) => ProviderOutputEvent;
