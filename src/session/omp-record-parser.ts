import type { HarnessTranscriptRecord } from '../contracts/substrate-contract.js';

export interface OmpToolCall {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export interface OmpToolResult {
  readonly id: string;
  readonly name?: string;
  readonly ok: boolean;
  readonly timeMs?: number;
  readonly durationMs?: number;
}

export interface OmpAssistantRecord extends HarnessTranscriptRecord {
  readonly kind: 'assistant';
  readonly thinking: readonly string[];
  readonly toolCalls: readonly OmpToolCall[];
  readonly timeMs?: number;
}

export interface OmpUserRecord extends HarnessTranscriptRecord {
  readonly kind: 'user' | 'steering';
  readonly timeMs?: number;
}

export interface OmpToolResultRecord extends HarnessTranscriptRecord {
  readonly kind: 'tool_result';
  readonly toolResult: OmpToolResult;
}

export interface OmpSessionExitRecord extends HarnessTranscriptRecord {
  readonly kind: 'session_exit';
  readonly reason?: string;
  readonly exitKind?: string;
}

export type OmpTranscriptRecord =
  | OmpAssistantRecord
  | OmpUserRecord
  | OmpToolResultRecord
  | OmpSessionExitRecord;

/** Parse the persisted JSONL shape emitted by omp's session store. */
export function parseOmpTranscriptLine(line: string): OmpTranscriptRecord | null {
  const value = parseObject(line);
  if (!value) return null;
  if (value.type === 'custom' && value.customType === 'session_exit') {
    const data = objectField(value, 'data') ?? {};
    const reason = stringField(data, 'reason');
    const exitKind = stringField(data, 'kind');
    const recordedAt = stringField(data, 'recordedAt') ?? stringField(value, 'recordedAt');
    return {
      kind: 'session_exit',
      raw: line,
      ...(reason === undefined ? {} : { reason }),
      ...(exitKind === undefined ? {} : { exitKind }),
      ...(recordedAt === undefined ? {} : { ts: recordedAt }),
    };
  }
  const message = objectField(value, 'message') ?? value;
  const role = stringField(message, 'role');
  const timeMs = recordTimeMs(value, message);
  const durationMs = toolDurationMs(value, message);
  const ts = recordTimestamp(value, message);
  if (role === 'toolResult') {
    const id =
      stringField(message, 'toolCallId') ??
      stringField(message, 'callId') ??
      stringField(message, 'id');
    if (!id) return null;
    const name = stringField(message, 'toolName') ?? stringField(message, 'name');
    const isError =
      message.isError === true ||
      value.isError === true ||
      message.status === 'error' ||
      message.status === 'err' ||
      message.status === 'failed' ||
      value.status === 'error' ||
      value.status === 'err' ||
      value.status === 'failed';
    return {
      kind: 'tool_result',
      raw: line,
      toolResult: {
        id,
        ...(name === undefined ? {} : { name }),
        ok: !isError,
        ...(timeMs === undefined ? {} : { timeMs }),
        ...(durationMs === undefined ? {} : { durationMs }),
      },
      ...(ts === undefined ? {} : { ts }),
    };
  }
  if (role === 'user') {
    const text = transcriptText(message.content ?? message.text);
    const steering = message.steering === true || value.steering === true;
    return {
      kind: steering ? 'steering' : 'user',
      raw: line,
      ...(text === undefined ? {} : { text }),
      ...(timeMs === undefined ? {} : { timeMs }),
      ...(ts === undefined ? {} : { ts }),
    };
  }
  if (role !== 'assistant') return null;

  const content = message.content ?? message.text;
  const thinking = contentParts(content)
    .filter((part) => part.type === 'thinking')
    .map((part) => (typeof part.thinking === 'string' ? part.thinking : ''))
    .filter((text) => text.length > 0);
  const toolCalls = contentParts(content)
    .filter((part) => part.type === 'toolCall')
    .map((part) => parseToolCall(part))
    .filter((call): call is OmpToolCall => call !== null);
  const text = transcriptText(content);
  return {
    kind: 'assistant',
    raw: line,
    thinking,
    toolCalls,
    ...(text === undefined ? {} : { text }),
    ...(timeMs === undefined ? {} : { timeMs }),
    ...(ts === undefined ? {} : { ts }),
  };
}

function parseToolCall(part: Record<string, unknown>): OmpToolCall | null {
  const name = stringField(part, 'name') ?? stringField(part, 'toolName');
  const id = stringField(part, 'id') ?? stringField(part, 'toolCallId');
  if (!name || !id) return null;
  return { id, name, summary: summarizeArguments(part.arguments) };
}

function summarizeArguments(argumentsValue: unknown): string {
  const parsed = parseArguments(argumentsValue);
  if (isObject(parsed)) {
    const preferred = [
      'command',
      'cmd',
      'path',
      'file',
      'query',
      'url',
      'text',
      'prompt',
      'code',
      'pattern',
      'args',
    ];
    for (const key of preferred) {
      const candidate = parsed[key];
      const summary = compactValue(candidate);
      if (summary) return truncate(summary);
    }
    for (const [key, candidate] of Object.entries(parsed)) {
      if (key === 'i' || key === 'intent' || key === 'timeout' || key === 'cwd') continue;
      const summary = compactValue(candidate);
      if (summary) return truncate(summary);
    }
  }
  return truncate(compactValue(parsed));
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function truncate(value: string): string {
  if (value.length <= 80) return value;
  return `${value.slice(0, 79)}…`;
}

function contentParts(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject);
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

function objectField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value[key];
  return isObject(candidate) ? candidate : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function recordTimestamp(
  value: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  for (const candidate of [value.timestamp, value.ts, message.timestamp, message.ts]) {
    if (typeof candidate === 'string') return candidate;
  }
  return undefined;
}

function toolDurationMs(
  value: Record<string, unknown>,
  message: Record<string, unknown>,
): number | undefined {
  const messageDetails = objectField(message, 'details');
  const valueDetails = objectField(value, 'details');
  const candidates = [
    message.durationMs,
    message.duration,
    value.durationMs,
    value.duration,
    messageDetails?.wallTimeMs,
    messageDetails?.durationMs,
    messageDetails?.duration,
    valueDetails?.wallTimeMs,
    valueDetails?.durationMs,
    valueDetails?.duration,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0)
      return candidate;
  }
  return undefined;
}

function recordTimeMs(
  value: Record<string, unknown>,
  message: Record<string, unknown>,
): number | undefined {
  for (const candidate of [
    value.timestamp,
    value.ts,
    message.timestamp,
    message.ts,
    value.createdAt,
    message.createdAt,
  ]) {
    const time = timestampMs(candidate);
    if (time !== undefined) return time;
  }
  return undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}
