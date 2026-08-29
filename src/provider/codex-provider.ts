import type {
  ProviderCapabilityMatrix,
  ProviderSession,
  ProviderSpawnRequest,
} from '../contracts/provider-contract.js';
import { CliProvider, type CliProviderOptions, type CliProviderSession } from './cli-provider.js';
import { isJsonObject } from './json.js';

interface CodexDecoderState {
  lineBuffer: string;
  readonly completedItems: Set<string>;
}

export class CodexProvider extends CliProvider {
  public readonly name = 'codex';
  private readonly resumedRefs = new Map<string, string>();

  public constructor(options: CliProviderOptions = {}) {
    super('codex', options);
  }

  public override async spawn(request: ProviderSpawnRequest): Promise<ProviderSession> {
    if (request.resumeRef) this.resumedRefs.set(request.sessionId, request.resumeRef);
    return super.spawn(request);
  }

  protected commandArgs(request: ProviderSpawnRequest): string[] {
    const resumeRef =
      request.resumeRef ?? (request.resume ? this.resumedRefs.get(request.sessionId) : undefined);
    if (resumeRef) return ['exec', 'resume', resumeRef, '--json', '--', request.prompt];
    if (request.resume) return ['exec', 'resume', '--last', '--json', '--', request.prompt];
    return ['exec', '--json', '--', request.prompt];
  }

  protected override extraEnv(request: ProviderSpawnRequest): NodeJS.ProcessEnv | undefined {
    return request.storageDir === undefined ? undefined : { CODEX_HOME: request.storageDir };
  }

  public capabilityMatrix(): ProviderCapabilityMatrix {
    return {
      provider: this.name,
      streaming: true,
      stop: true,
      models: ['configured'],
    };
  }

  protected override initializeDecoder(session: CliProviderSession): void {
    session.decoderState = {
      lineBuffer: '',
      completedItems: new Set<string>(),
    } satisfies CodexDecoderState;
  }

  protected override decodeStdout(
    session: CliProviderSession,
    text: string,
    flush: boolean,
  ): readonly string[] {
    const state = session.decoderState as CodexDecoderState;
    state.lineBuffer += text;
    const lines = state.lineBuffer.split('\n');
    state.lineBuffer = flush ? '' : (lines.pop() ?? '');
    return lines.flatMap((line) => this.decodeLine(line, state));
  }

  private decodeLine(line: string, state: CodexDecoderState): readonly string[] {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized.trim()) return [];

    let event: unknown;
    try {
      event = JSON.parse(normalized) as unknown;
    } catch {
      return [normalized];
    }
    if (!isJsonObject(event)) return [];

    const eventType = typeof event.type === 'string' ? event.type : '';
    if (eventType === 'item.completed') {
      const item = isJsonObject(event.item) ? event.item : undefined;
      const id = item && typeof item.id === 'string' ? item.id : undefined;
      if (id && state.completedItems.has(id)) return [];
      if (id) state.completedItems.add(id);
      return item && isMessageItem(item) ? textFromMessage(item) : [];
    }
    if (eventType === 'message' || eventType === 'agent_message') {
      return textFromMessage(event);
    }
    if (eventType.endsWith('.delta') || eventType === 'message_update') {
      return textFromDelta(event);
    }
    return [];
  }
}

function isMessageItem(value: Record<string, unknown>): boolean {
  const type = value.type;
  return type === 'agent_message' || type === 'assistant_message' || type === 'message';
}

function textFromMessage(value: Record<string, unknown>): readonly string[] {
  const text = value.text;
  if (typeof text === 'string' && text) return [text];
  return textFromContent(value.content);
}

function textFromDelta(value: Record<string, unknown>): readonly string[] {
  const delta = value.delta;
  if (typeof delta === 'string' && delta) return [delta];
  if (isJsonObject(delta)) return textFromMessage(delta);
  return textFromMessage(value);
}

function textFromContent(content: unknown): readonly string[] {
  if (!Array.isArray(content)) return [];
  const text = content
    .filter(isJsonObject)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('');
  return text ? [text] : [];
}
