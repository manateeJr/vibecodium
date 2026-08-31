import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { OmpHarnessPlugin } from '../src/provider/omp-harness-plugin.js';
import { parseOmpTranscriptLine } from '../src/session/omp-record-parser.js';
import { SessionTranscriptTailer } from '../src/session/transcript-tailer.js';

class TestContext implements SubsystemContext {
  public readonly events: EventEnvelope[] = [];
  private nextSequence = 1;

  public registerProjector(name: string, onEvent: EventHandler, from_seq?: number): void {
    void name;
    void onEvent;
    void from_seq;
  }

  public registerCommand(name: string, handler: (command: unknown) => unknown): void {
    void name;
    void handler;
  }

  public registerListener(name: string, handler: EventHandler): void {
    void name;
    void handler;
  }

  public subscribe(from_seq: number, onEvent: EventHandler): () => void {
    void from_seq;
    void onEvent;
    return () => undefined;
  }

  public append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number {
    const event: EventEnvelope<K> = {
      stream_id,
      seq: this.nextSequence,
      type,
      payload,
      ts: new Date(this.nextSequence * 1000).toISOString(),
    };
    this.nextSequence += 1;
    this.events.push(event);
    return event.seq;
  }
}

const plugin = new OmpHarnessPlugin();

function assistant(
  timestamp: string,
  content: readonly Record<string, unknown>[],
  stopReason = 'toolUse',
): string {
  return JSON.stringify({
    type: 'message',
    timestamp,
    message: { role: 'assistant', content },
    stopReason,
  });
}

function toolResult(timestamp: string, toolCallId: string, isError = false): string {
  return JSON.stringify({
    type: 'message',
    timestamp,
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      isError,
      content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
    },
  });
}

test('OMP parser exposes thinking, tool calls, summaries, and tool results', () => {
  const line = assistant('2026-08-31T00:00:00.000Z', [
    { type: 'thinking', thinking: 'Inspect the workspace.' },
    {
      type: 'toolCall',
      id: 'call-1',
      name: 'bash',
      arguments: { command: 'ls -la /tmp/vibecodium' },
    },
  ]);
  const record = parseOmpTranscriptLine(line);
  assert.ok(record);
  assert.equal(record.kind, 'assistant');
  if (record.kind !== 'assistant') return;
  assert.deepEqual(record.thinking, ['Inspect the workspace.']);
  assert.deepEqual(record.toolCalls, [
    { id: 'call-1', name: 'bash', summary: 'ls -la /tmp/vibecodium' },
  ]);
  assert.equal(record.timeMs, Date.parse('2026-08-31T00:00:00.000Z'));

  const result = parseOmpTranscriptLine(toolResult('2026-08-31T00:00:01.250Z', 'call-1'));
  assert.ok(result);
  assert.deepEqual(result, {
    kind: 'tool_result',
    raw: line.replace(/.*/, toolResult('2026-08-31T00:00:01.250Z', 'call-1')),
    toolResult: {
      id: 'call-1',
      name: 'bash',
      ok: true,
      timeMs: Date.parse('2026-08-31T00:00:01.250Z'),
    },
    ts: '2026-08-31T00:00:01.250Z',
  });
});

test('tailer persists thinking, tool status updates, text, and suppresses whitespace output', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-reasoning-'));
  const transcriptPath = path.join(root, 'session.jsonl');
  writeFileSync(transcriptPath, '');
  const context = new TestContext();
  const tailer = new SessionTranscriptTailer({
    transcriptPath,
    sessionId: 'reasoning-session',
    streamId: 'session:reasoning-session',
    plugin,
    append: context.append.bind(context),
  });
  const run = assistant('2026-08-31T00:00:00.000Z', [
    { type: 'thinking', thinking: 'I should inspect the directory.' },
    {
      type: 'toolCall',
      id: 'call-ok',
      name: 'bash',
      arguments: { command: 'ls -la /tmp' },
    },
  ]);
  const failedRun = assistant('2026-08-31T00:00:02.000Z', [
    { type: 'toolCall', id: 'call-err', name: 'read', arguments: { path: '/missing' } },
  ]);
  try {
    await tailer.start();
    appendFileSync(
      transcriptPath,
      [
        run,
        toolResult('2026-08-31T00:00:01.250Z', 'call-ok'),
        failedRun,
        toolResult('2026-08-31T00:00:02.500Z', 'call-err', true),
        assistant('2026-08-31T00:00:03.000Z', [{ type: 'text', text: 'done' }], 'stop'),
        assistant('2026-08-31T00:00:04.000Z', [{ type: 'text', text: ' \n\t' }], 'stop'),
      ].join('\n') + '\n',
    );
    await tailer.readAvailable();

    const outputs = context.events.filter(
      (event): event is EventEnvelope<'session_output'> => event.type === 'session_output',
    );
    assert.deepEqual(
      outputs.map((event) => event.payload.kind),
      ['thinking', 'tool', 'tool', 'tool', 'tool', 'text'],
    );
    assert.deepEqual(outputs[0]?.payload, {
      session_id: 'reasoning-session',
      index: 0,
      text: 'I should inspect the directory.',
      kind: 'thinking',
    });
    assert.deepEqual(outputs[1]?.payload, {
      session_id: 'reasoning-session',
      index: 1,
      text: '',
      kind: 'tool',
      tool: { name: 'bash', summary: 'ls -la /tmp', status: 'run' },
    });
    assert.deepEqual(outputs[2]?.payload, {
      session_id: 'reasoning-session',
      index: 1,
      text: '',
      kind: 'tool',
      tool: { name: 'bash', summary: 'ls -la /tmp', status: 'ok', ms: 1250 },
    });
    assert.deepEqual(outputs[3]?.payload, {
      session_id: 'reasoning-session',
      index: 2,
      text: '',
      kind: 'tool',
      tool: { name: 'read', summary: '/missing', status: 'run' },
    });
    assert.deepEqual(outputs[4]?.payload, {
      session_id: 'reasoning-session',
      index: 2,
      text: '',
      kind: 'tool',
      tool: { name: 'read', summary: '/missing', status: 'err', ms: 500 },
    });
    assert.deepEqual(outputs[5]?.payload, {
      session_id: 'reasoning-session',
      index: 3,
      text: 'done',
      kind: 'text',
    });
    assert.equal(
      outputs
        .filter((event) => event.payload.kind === 'text')
        .every((event) => event.payload.text.trim().length > 0),
      true,
    );
    assert.equal(context.events.filter((event) => event.type === 'turn_complete').length, 2);
  } finally {
    await tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('OMP plain assistant records retain final text semantics', () => {
  const record = parseOmpTranscriptLine(
    assistant('2026-08-31T00:00:00.000Z', [{ type: 'text', text: 'plain reply' }], 'stop'),
  );
  assert.ok(record);
  assert.equal(record.kind, 'assistant');
  if (record.kind !== 'assistant') return;
  assert.deepEqual(record.thinking, []);
  assert.deepEqual(record.toolCalls, []);
  assert.equal(record.text, 'plain reply');
});
