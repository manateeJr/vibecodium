import type { HarnessTranscriptRecord } from '../contracts/substrate-contract.js';

export interface OmpToolCall {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly ask?: OmpAskDetail;
}

export interface OmpAskOption {
  readonly label: string;
  readonly description?: string;
}

export interface OmpAskQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly OmpAskOption[];
}

export interface OmpAskDetail {
  readonly askId: string;
  readonly questions: readonly OmpAskQuestion[];
}

export interface OmpToolResult {
  readonly id: string;
  readonly name?: string;
  readonly ok: boolean;
  readonly timeMs?: number;
  readonly durationMs?: number;
}

export interface OmpContextSnapshot {
  readonly tokens: number;
  readonly model?: string;
}

export interface OmpAssistantRecord extends HarnessTranscriptRecord {
  readonly kind: 'assistant';
  readonly thinking: readonly string[];
  readonly toolCalls: readonly OmpToolCall[];
  readonly timeMs?: number;
  readonly context?: OmpContextSnapshot;
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
  OmpAssistantRecord | OmpUserRecord | OmpToolResultRecord | OmpSessionExitRecord;

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
    .filter((part) => part.type === 'toolCall' || part.type === 'tool_execution_start')
    .map((part) => parseToolCall(part))
    .filter((call): call is OmpToolCall => call !== null);
  const text = transcriptText(content);
  const contextSnapshot = objectField(message, 'contextSnapshot');
  const tokens = positiveFiniteNumberField(contextSnapshot, 'promptTokens');
  const model = stringField(message, 'model');
  const context =
    tokens === undefined
      ? undefined
      : {
          tokens,
          ...(model === undefined || model.length === 0 ? {} : { model }),
        };
  return {
    kind: 'assistant',
    raw: line,
    thinking,
    toolCalls,
    ...(text === undefined ? {} : { text }),
    ...(timeMs === undefined ? {} : { timeMs }),
    ...(ts === undefined ? {} : { ts }),
    ...(context === undefined ? {} : { context }),
  };
}

function parseToolCall(part: Record<string, unknown>): OmpToolCall | null {
  const name = stringField(part, 'name') ?? stringField(part, 'toolName');
  const id = stringField(part, 'id') ?? stringField(part, 'toolCallId');
  if (!name || !id) return null;
  // tool_execution_start parts carry the invocation under `args`; legacy toolCall parts use `arguments`.
  const rawArgs =
    part.type === 'tool_execution_start' ? (part.args ?? part.arguments) : part.arguments;
  const ask = name === 'ask' ? parseAskDetail(rawArgs, id) : undefined;
  const summary =
    ask !== undefined && ask.questions.length > 0
      ? truncateAskSummary(ask)
      : summarizeArguments(rawArgs);
  return { id, name, summary, ...(ask === undefined ? {} : { ask }) };
}

function parseAskDetail(value: unknown, askId: string): OmpAskDetail | undefined {
  const parsed = parseArguments(value);
  if (!isObject(parsed) || !Array.isArray(parsed.questions)) return undefined;
  const questions: OmpAskQuestion[] = [];
  parsed.questions.forEach((entry, index) => {
    const question = parseAskQuestion(entry, index);
    if (question) questions.push(question);
  });
  if (questions.length === 0) return undefined;
  return { askId, questions };
}

function parseAskQuestion(entry: unknown, index: number): OmpAskQuestion | undefined {
  if (!isObject(entry)) return undefined;
  const question =
    stringField(entry, 'question') ??
    stringField(entry, 'prompt') ??
    stringField(entry, 'text') ??
    '';
  if (!question) return undefined;
  const options: OmpAskOption[] = [];
  if (Array.isArray(entry.options)) {
    for (const raw of entry.options) {
      if (typeof raw === 'string') {
        if (raw.trim()) options.push({ label: raw });
      } else if (isObject(raw)) {
        const label =
          stringField(raw, 'label') ?? stringField(raw, 'id') ?? stringField(raw, 'title') ?? '';
        if (!label) continue;
        const description = stringField(raw, 'description');
        options.push({ label, ...(description === undefined ? {} : { description }) });
      }
    }
  }
  if (options.length === 0) return undefined;
  return {
    id: stringField(entry, 'id') ?? `q${index + 1}`,
    header: stringField(entry, 'header') ?? stringField(entry, 'title') ?? '',
    question,
    options,
  };
}

function truncateAskSummary(ask: OmpAskDetail): string {
  return truncate(
    ask.questions
      .map((entry) => (entry.header ? `${entry.header}: ${entry.question}` : entry.question))
      .join(' / '),
  );
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

function positiveFiniteNumberField(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : undefined;
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
