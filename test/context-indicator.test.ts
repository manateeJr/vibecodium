import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import type { EventHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { OmpHarnessPlugin } from '../src/provider/omp-harness-plugin.js';
import {
  contextWindowFor,
  parseModelCatalog,
  primeModelContextWindows,
  resetModelContextWindows,
} from '../src/session/model-context-window.js';
import { parseOmpTranscriptLine } from '../src/session/omp-record-parser.js';
import { SessionTranscriptTailer } from '../src/session/transcript-tailer.js';

class CapturingContext implements SubsystemContext {
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

function assistantLine(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'message',
    timestamp: '2026-08-31T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      ...fields,
    },
    stopReason: 'stop',
  });
}

test('OMP parser extracts context tokens and model from assistant records', () => {
  const line = JSON.stringify({
    type: 'message',
    timestamp: '2026-08-31T00:00:00.000Z',
    message: {
      role: 'assistant',
      model: 'gpt-5.6-luna',
      contextSnapshot: { promptTokens: 92480, nonMessageTokens: 41716 },
      content: [{ type: 'text', text: 'reply' }],
    },
    stopReason: 'stop',
  });
  const record = parseOmpTranscriptLine(line);
  assert.ok(record);
  assert.equal(record.kind, 'assistant');
  if (record.kind !== 'assistant') return;
  assert.deepEqual(record.context, { tokens: 92480, model: 'gpt-5.6-luna' });
});

test('OMP parser ignores absent and invalid context snapshots outside assistant records', () => {
  const assistantCases = [
    assistantLine({ model: 'gpt-5.6-luna' }),
    assistantLine({ contextSnapshot: { promptTokens: 0 } }),
    assistantLine({ contextSnapshot: { promptTokens: -1 } }),
    assistantLine({ contextSnapshot: { promptTokens: '92480' } }),
  ];
  for (const line of assistantCases) {
    const record = parseOmpTranscriptLine(line);
    assert.ok(record);
    assert.equal(record.kind, 'assistant');
    if (record.kind === 'assistant') assert.equal(record.context, undefined);
  }

  const user = parseOmpTranscriptLine(
    JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        contextSnapshot: { promptTokens: 92480 },
        content: 'prompt',
      },
    }),
  );
  assert.ok(user);
  assert.equal(user.kind, 'user');

  const toolResult = parseOmpTranscriptLine(
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        contextSnapshot: { promptTokens: 92480 },
        content: [{ type: 'text', text: 'ok' }],
      },
    }),
  );
  assert.ok(toolResult);
  assert.equal(toolResult.kind, 'tool_result');
});

test('model catalogs map ids and selectors and reject invalid windows', () => {
  const catalog = parseModelCatalog(
    JSON.stringify({
      models: [
        { id: 'gpt-5.6-luna', selector: 'openai/gpt-5.6-luna', contextWindow: 272000 },
        { id: 'zero', selector: 'provider/zero', contextWindow: 0 },
        { id: 'negative', contextWindow: -1 },
        { id: 'text', contextWindow: '272000' },
        { id: 'missing' },
        { id: '', selector: '', contextWindow: 128000 },
      ],
    }),
  );
  assert.equal(catalog.size, 2);
  assert.equal(catalog.get('gpt-5.6-luna'), 272000);
  assert.equal(catalog.get('openai/gpt-5.6-luna'), 272000);
  assert.deepEqual([...parseModelCatalog('{malformed')], []);
  assert.deepEqual([...parseModelCatalog(JSON.stringify({ models: {} }))], []);
});

test('contextWindowFor reads a primed catalog without invoking omp', () => {
  resetModelContextWindows([['gpt-5.6-luna', 272000]]);
  try {
    assert.equal(contextWindowFor('gpt-5.6-luna'), 272000);
    assert.equal(contextWindowFor('unknown-model'), undefined);
    assert.equal(contextWindowFor(''), undefined);
    assert.equal(contextWindowFor(undefined), undefined);
  } finally {
    resetModelContextWindows([]);
  }
});

test('model catalog priming swallows rejected runs and remains empty', async () => {
  resetModelContextWindows();
  let calls = 0;
  const run = async (): Promise<string> => {
    calls += 1;
    throw new Error('omp unavailable');
  };
  await assert.doesNotReject(
    Promise.all([primeModelContextWindows(run), primeModelContextWindows(run)]),
  );
  assert.equal(calls, 1);
  assert.equal(contextWindowFor('gpt-5.6-luna'), undefined);
  resetModelContextWindows([]);
});

test('explicit catalog priming retries after a rejected run', async () => {
  resetModelContextWindows();
  let attempts = 0;
  const rejectedRun = async (): Promise<string> => {
    attempts += 1;
    throw new Error('omp unavailable');
  };
  const successfulRun = async (): Promise<string> => {
    attempts += 1;
    return JSON.stringify({
      models: [{ id: 'gpt-5.6-luna', contextWindow: 272000 }],
    });
  };
  await primeModelContextWindows(rejectedRun);
  assert.equal(contextWindowFor('gpt-5.6-luna'), undefined);
  await primeModelContextWindows(successfulRun);
  assert.equal(contextWindowFor('gpt-5.6-luna'), 272000);
  assert.equal(attempts, 2);
  resetModelContextWindows([]);
});

test('tailer emits one deduplicated session_context event for identical snapshots', async () => {
  resetModelContextWindows([['gpt-5.6-luna', 272000]]);
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-context-'));
  const transcriptPath = path.join(root, 'session.jsonl');
  writeFileSync(transcriptPath, '');
  const context = new CapturingContext();
  const tailer = new SessionTranscriptTailer({
    transcriptPath,
    sessionId: 'context-session',
    streamId: 'session:context-session',
    plugin,
    append: context.append.bind(context),
  });
  const line = assistantLine({
    model: 'gpt-5.6-luna',
    contextSnapshot: { promptTokens: 92480, nonMessageTokens: 41716 },
  });
  try {
    await tailer.start();
    appendFileSync(transcriptPath, `${line}\n${line}\n`);
    await tailer.readAvailable();
    const contextEvents = context.events.filter(
      (event): event is EventEnvelope<'session_context'> => event.type === 'session_context',
    );
    assert.equal(contextEvents.length, 1);
    assert.deepEqual(contextEvents[0]?.payload, {
      session_id: 'context-session',
      tokens: 92480,
      model: 'gpt-5.6-luna',
      context_window: 272000,
    });
  } finally {
    await tailer.stop();
    rmSync(root, { recursive: true, force: true });
    resetModelContextWindows([]);
  }
});
