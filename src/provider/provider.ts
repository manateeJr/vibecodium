import { randomUUID } from 'node:crypto';
import type {
  ProviderCapabilityMatrix,
  ProviderChunk,
  ProviderSession,
  ProviderSessionRef,
  ProviderSpawnRequest,
} from '../contracts/provider-contract.js';

export type {
  ProviderCapabilityMatrix,
  ProviderChunk,
  ProviderSession,
  ProviderSessionRef,
  ProviderSpawnRequest,
} from '../contracts/provider-contract.js';

export class ProviderNotImplementedError extends Error {
  public constructor(provider: string) {
    super(`provider adapter not implemented: ${provider}`);
    this.name = 'ProviderNotImplementedError';
  }
}

export class EchoProvider implements ProviderSessionRef {
  public readonly name = 'fake';

  public async spawn(request: ProviderSpawnRequest): Promise<ProviderSession> {
    return { id: randomUUID(), request, stopped: false };
  }

  public async *stream(session: ProviderSession): AsyncIterable<ProviderChunk> {
    const words = session.request.prompt.trim().split(/\s+/).filter(Boolean);
    const output = words.length > 0 ? words : [''];
    for (const [index, word] of output.entries()) {
      if (session.stopped) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
      yield { index, text: `echo:${word}` };
    }
  }

  public async stop(session: ProviderSession): Promise<void> {
    session.stopped = true;
  }

  public capabilityMatrix(): ProviderCapabilityMatrix {
    return {
      provider: this.name,
      streaming: true,
      stop: true,
      models: ['echo'],
    };
  }
}

export class NotImplementedProvider implements ProviderSessionRef {
  public constructor(public readonly name: string) {}

  public async spawn(): Promise<ProviderSession> {
    throw new ProviderNotImplementedError(this.name);
  }

  public stream(): AsyncIterable<ProviderChunk> {
    throw new ProviderNotImplementedError(this.name);
  }

  public async stop(): Promise<void> {
    throw new ProviderNotImplementedError(this.name);
  }

  public capabilityMatrix(): ProviderCapabilityMatrix {
    throw new ProviderNotImplementedError(this.name);
  }
}

export function providerByName(name: string): ProviderSessionRef {
  if (name === 'fake' || name === 'echo') return new EchoProvider();
  if (name === 'claude' || name === 'omp' || name === 'codex')
    return new NotImplementedProvider(name);
  throw new Error(`unknown provider: ${name}`);
}
