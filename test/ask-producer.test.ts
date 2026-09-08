import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EventEnvelope, EventKind, EventPayload } from '../src/contracts/events.js';
import { isAskRequestedPayload } from '../src/contracts/events.js';
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
const NOW_MS = Date.parse('2026-09-08T00:00:00.000Z');

function userLine(timestamp: string, text: string): string {
  return JSON.stringify({
    type: 'message',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function askAssistant(timestamp: string, toolCallId: string): string {
  return JSON.stringify({
    type: 'message',
    timestamp,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_execution_start',
          toolCallId,
          toolName: 'ask',
          args: {
            questions: [
              {
                id: 'q1',
                header: 'Scope',
                question: 'File the report or map it first?',
                options: [
                  { label: 'File it', description: 'Create the issue now' },
                  { label: "Don't file" },
                ],
              },
            ],
          },
        },
      ],
    },
    stopReason: 'toolUse',
  });
}

function askToolResult(timestamp: string, toolCallId: string): string {
  return JSON.stringify({
    type: 'message',
    timestamp,
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'ask',
      content: [{ type: 'text', text: 'File it' }],
    },
  });
}

function actionRequested(context: TestContext): EventEnvelope<'action_requested'>[] {
  return context.events.filter(
    (event): event is EventEnvelope<'action_requested'> => event.type === 'action_requested',
  );
}

test('parser surfaces tool_execution_start ask as structured pending-ask', () => {
  const record = parseOmpTranscriptLine(askAssistant('2026-09-08T00:00:01.000Z', 'ask-1'));
  assert.ok(record);
  assert.equal(record.kind, 'assistant');
  if (record.kind !== 'assistant') return;
  assert.equal(record.toolCalls.length, 1);
  const call = record.toolCalls[0];
  assert.ok(call);
  assert.equal(call.id, 'ask-1');
  assert.equal(call.name, 'ask');
  assert.deepEqual(call.ask, {
    askId: 'ask-1',
    questions: [
      {
        id: 'q1',
        header: 'Scope',
        question: 'File the report or map it first?',
        options: [
          { label: 'File it', description: 'Create the issue now' },
          { label: "Don't file" },
        ],
      },
    ],
  });
});

test('parser also surfaces legacy toolCall ask parts and ignores malformed ask args', () => {
  const legacy = parseOmpTranscriptLine(
    JSON.stringify({
      type: 'message',
      timestamp: '2026-09-08T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'ask-legacy',
            name: 'ask',
            arguments: JSON.stringify({
              questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }],
            }),
          },
          { type: 'toolCall', id: 'call-bash', name: 'bash', arguments: { command: 'ls' } },
        ],
      },
      stopReason: 'toolUse',
    }),
  );
  assert.ok(legacy);
  assert.equal(legacy.kind, 'assistant');
  if (legacy.kind !== 'assistant') return;
  assert.equal(legacy.toolCalls.length, 2);
  assert.deepEqual(legacy.toolCalls[0]?.ask, {
    askId: 'ask-legacy',
    questions: [
      { id: 'q1', header: '', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ],
  });
  assert.equal(legacy.toolCalls[1]?.ask, undefined);

  const malformed = parseOmpTranscriptLine(
    JSON.stringify({
      type: 'message',
      timestamp: '2026-09-08T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_execution_start', toolCallId: 'ask-bad', toolName: 'ask', args: {} },
        ],
      },
      stopReason: 'toolUse',
    }),
  );
  assert.ok(malformed);
  assert.equal(malformed.kind, 'assistant');
  if (malformed.kind !== 'assistant') return;
  assert.equal(malformed.toolCalls.length, 1);
  assert.equal(malformed.toolCalls[0]?.ask, undefined);
});

test('parked ask emits one action_requested and keeps the turn open', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-ask-producer-'));
  const transcriptPath = path.join(root, 'session.jsonl');
  writeFileSync(transcriptPath, '');
  const context = new TestContext();
  const tailer = new SessionTranscriptTailer({
    transcriptPath,
    sessionId: 'ask-session',
    streamId: 'session:ask-session',
    plugin,
    append: context.append.bind(context),
    now: () => NOW_MS,
  });
  try {
    await tailer.start();
    appendFileSync(
      transcriptPath,
      `${userLine('2026-09-08T00:00:00.000Z', 'start the report')}\n${askAssistant('2026-09-08T00:00:01.000Z', 'ask-1')}\n`,
    );
    await tailer.readAvailable();

    const requests = actionRequested(context);
    assert.equal(requests.length, 1, 'parked ask emits exactly one action_requested');
    assert.ok(isAskRequestedPayload(requests[0]?.payload));
    assert.deepEqual(requests[0]?.payload, {
      request_id: 'ask-1',
      action: 'ask.answer',
      scope: { session_id: 'ask-session' },
      session_id: 'ask-session',
      turn: 1,
      ask_id: 'ask-1',
      questions: [
        {
          id: 'q1',
          header: 'Scope',
          question: 'File the report or map it first?',
          options: [
            { label: 'File it', description: 'Create the issue now' },
            { label: "Don't file" },
          ],
        },
      ],
      source: 'omp-ask',
      requested_at: new Date(NOW_MS).toISOString(),
    });
    assert.equal(
      context.events.some((event) => event.type === 'turn_complete'),
      false,
      'turn stays open while the ask is parked',
    );
    assert.equal(tailer.isIdle, false);
  } finally {
    await tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('approval clears pendingTools and re-tail emits no duplicates', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-ask-resolve-'));
  const transcriptPath = path.join(root, 'session.jsonl');
  writeFileSync(transcriptPath, '');
  const context = new TestContext();
  const tailer = new SessionTranscriptTailer({
    transcriptPath,
    sessionId: 'ask-session',
    streamId: 'session:ask-session',
    plugin,
    append: context.append.bind(context),
    now: () => NOW_MS,
  });
  try {
    await tailer.start();
    appendFileSync(
      transcriptPath,
      `${userLine('2026-09-08T00:00:00.000Z', 'start the report')}\n${askAssistant('2026-09-08T00:00:01.000Z', 'ask-1')}\n`,
    );
    await tailer.readAvailable();
    assert.equal(actionRequested(context).length, 1);

    assert.equal(tailer.resolveAsk('ask-1', { approved: true }), true);
    const completions = context.events
      .filter((event): event is EventEnvelope<'session_output'> => event.type === 'session_output')
      .filter((event) => event.payload.kind === 'tool');
    assert.equal(completions.length, 2, 'run marker plus approval completion');
    assert.equal(completions.at(-1)?.payload.tool?.status, 'ok');

    // A late native toolResult for the resolved ask is ignored: pendingTools was cleared.
    appendFileSync(transcriptPath, `${askToolResult('2026-09-08T00:00:02.000Z', 'ask-1')}\n`);
    await tailer.readAvailable();
    assert.equal(
      context.events
        .filter(
          (event): event is EventEnvelope<'session_output'> => event.type === 'session_output',
        )
        .filter((event) => event.payload.kind === 'tool').length,
      2,
      'late toolResult after approval emits nothing',
    );
    assert.equal(tailer.resolveAsk('ask-1', { approved: true }), false);
    assert.equal(tailer.resolveAsk('unknown-ask', { approved: false }), false);

    // Re-tail (no new bytes, then duplicate ask bytes) emits no second request.
    await tailer.readAvailable();
    appendFileSync(transcriptPath, `${askAssistant('2026-09-08T00:00:01.000Z', 'ask-1')}\n`);
    await tailer.readAvailable();
    assert.equal(actionRequested(context).length, 1, 'no duplicate emits on re-tail');
    assert.equal(
      context.events.some((event) => event.type === 'turn_complete'),
      false,
      'resolution alone does not close the turn',
    );
  } finally {
    await tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('denial completes the ask tool as err', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-ask-deny-'));
  const transcriptPath = path.join(root, 'session.jsonl');
  writeFileSync(transcriptPath, '');
  const context = new TestContext();
  const tailer = new SessionTranscriptTailer({
    transcriptPath,
    sessionId: 'ask-session',
    streamId: 'session:ask-session',
    plugin,
    append: context.append.bind(context),
    now: () => NOW_MS,
  });
  try {
    await tailer.start();
    appendFileSync(
      transcriptPath,
      `${userLine('2026-09-08T00:00:00.000Z', 'start the report')}\n${askAssistant('2026-09-08T00:00:01.000Z', 'ask-1')}\n`,
    );
    await tailer.readAvailable();
    assert.equal(tailer.resolveAsk('ask-1', { approved: false }), true);
    const completions = context.events
      .filter((event): event is EventEnvelope<'session_output'> => event.type === 'session_output')
      .filter((event) => event.payload.kind === 'tool');
    assert.equal(completions.at(-1)?.payload.tool?.status, 'err');
    assert.equal(completions.at(-1)?.payload.tool?.name, 'ask');
  } finally {
    await tailer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
