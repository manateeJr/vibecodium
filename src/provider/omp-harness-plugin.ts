import type {
  HarnessPlugin,
  HarnessSessionContext,
  HarnessTranscriptRecord,
} from '../contracts/substrate-contract.js';

export class OmpHarnessPlugin implements HarnessPlugin {
  public readonly name = 'omp';
  public readonly injectionRecipe = {
    clearKeys: ['ctrl_u'],
    submitKeys: ['enter'],
  } as const;

  public launchArgv(context: HarnessSessionContext): readonly string[] {
    const args = ['omp'];
    if (context.storageDir !== undefined) args.push('--session-dir', context.storageDir);
    if (context.resumeRef !== undefined) args.push('--resume', context.resumeRef);
    if (context.prompt !== undefined) args.push(context.prompt);
    return args;
  }

  public idleDetector(record: HarnessTranscriptRecord): boolean {
    if (record.kind !== 'assistant') return false;
    const value = parseObject(record.raw);
    if (!value) return false;
    const message = objectField(value, 'message') ?? value;
    return (
      value.type === undefined || value.type === 'message'
    ) && message.role === 'assistant' && message.stopReason === 'stop';
  }

  public parseTranscriptLine(line: string): HarnessTranscriptRecord | null {
    const value = parseObject(line);
    if (!value) return null;
    const message = objectField(value, 'message') ?? value;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const steering = message.steering === true || value.steering === true;
    const text = transcriptText(message.content ?? message.text);
    const timestamp =
      stringField(message, 'ts') ??
      stringField(message, 'timestamp') ??
      stringField(value, 'ts') ??
      stringField(value, 'timestamp');
    return {
      kind: role === 'user' && steering ? 'steering' : role,
      raw: line,
      ...(text === undefined ? {} : { text }),
      ...(timestamp === undefined ? {} : { ts: timestamp }),
    };
  }
}

export const ompHarnessPlugin: HarnessPlugin = new OmpHarnessPlugin();

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const candidate = value[key];
  return isObject(candidate) ? candidate : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function transcriptText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter(isObject)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
  return text || undefined;
}
