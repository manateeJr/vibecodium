import {
  command,
  latestCompletedTurn,
  readEvents,
  turnTextFromEvents,
  unescapeTelegramMarkdown,
  waitFor,
} from './io.mjs';
import { captureSession } from './capture.mjs';
import { createStepRecord, printStep } from './report.mjs';

const echoWaitMs = 5_000;

export async function replayTerminalStep({
  context,
  stub,
  step,
  stepNumber,
  state,
  threadId,
  timeoutMs,
  signal,
  onTimeout,
  records,
  strictEcho,
  failures,
}) {
  if (state.sessionId === undefined) throw new Error('terminal step has no Telegram session');
  const startedAt = Date.now();
  const fromCall = stub.calls.length;
  const beforeEvents = await readEvents(context.runtime, state.sessionId);
  let turn;
  let eventText;
  let detail;
  if (step.text !== undefined) {
    const result = await command(context.runtime, 'session.send', {
      session_id: state.sessionId,
      prompt: step.text,
    });
    if (!Number.isInteger(result?.turn)) throw new Error('session.send omitted turn');
    turn = result.turn;
    const events = await waitFor(
      `terminal turn_complete turn=${turn}`,
      async () => {
        const current = await readEvents(context.runtime, state.sessionId);
        return current.some(
          (event) => event?.type === 'turn_complete' && event.payload?.turn === turn,
        )
          ? current
          : false;
      },
      { timeoutMs, signal, onTimeout },
    );
    eventText = turnTextFromEvents(events, turn) ?? '';
  } else {
    const result = await command(context.runtime, 'session.send_keys', {
      session_id: state.sessionId,
      keys: step.keys,
    });
    detail = `sent ${result?.sent ?? 0} terminal keys`;
    const events = await readEvents(context.runtime, state.sessionId);
    const nextTurn = latestCompletedTurn(events);
    if (nextTurn > latestCompletedTurn(beforeEvents)) {
      turn = nextTurn;
      eventText = turnTextFromEvents(events, turn) ?? '';
    }
  }
  const capture = await captureSession({
    runtime: context.runtime,
    sessionId: state.sessionId,
    turn,
    timeoutMs,
    signal,
    onTimeout,
  });
  const transcriptText = turn === undefined ? undefined : capture.transcriptText;
  const prompt = step.text ?? promptFromEvents(capture.events, turn);
  const echo =
    strictEcho && turn !== undefined
      ? await waitFor(
          `Telegram echo turn=${turn}`,
          () => findEchoPair(stub.calls, fromCall, threadId, prompt, transcriptText),
          { timeoutMs: Math.min(timeoutMs, echoWaitMs), signal },
        ).catch((error) => {
          if (signal?.aborted) throw error;
          return undefined;
        })
      : findEchoPair(stub.calls, fromCall, threadId, prompt, transcriptText);
  state.lastTurn = turn ?? state.lastTurn;
  if (echo !== undefined) state.telegramText = echo.text;
  state.transcriptTurns = capture.transcript.turns.length;
  if (transcriptText !== undefined) state.transcriptText = transcriptText;
  if (strictEcho && turn !== undefined && echo === undefined) {
    failures.push(
      `[expect] FAIL echo expected terminal turn ${turn} in Telegram; actual echo missing`,
    );
  }
  const record = createStepRecord(stepNumber, {
    turn,
    latencyMs: Date.now() - startedAt,
    telegramText: echo?.text,
    telegramMessageId: echo?.messageId,
    transcriptText,
    transcriptExists: capture.transcript.exists,
    transcriptTurns: state.transcriptTurns,
    eventCount: capture.events.length,
  });
  records.push(record);
  if (detail !== undefined) globalThis.console.log(`[terminal] step=${stepNumber} ${detail}`);
  printStep(record);
  if (eventText !== undefined && eventText !== transcriptText) {
    globalThis.console.log(`[terminal] step=${stepNumber} event text differs from transcript text`);
  }
}

function promptFromEvents(events, turn) {
  if (turn === undefined) return undefined;
  const input = events.find(
    (event) => event?.type === 'session_input' && event.payload?.turn === turn,
  );
  return typeof input?.payload?.text === 'string' ? input.payload.text : undefined;
}

function findEchoPair(calls, fromIndex, threadId, prompt, assistantText) {
  if (typeof prompt !== 'string' || typeof assistantText !== 'string') return undefined;
  const recent = calls.slice(fromIndex);
  for (const [index, call] of recent.entries()) {
    const header = messageBody(call, threadId);
    if (header === undefined || unescapeTelegramMarkdown(header.text) !== `▶ ${prompt}`) continue;
    for (const candidate of recent.slice(index + 1)) {
      const output = messageBody(candidate, threadId);
      if (output === undefined) continue;
      if (sameText(output.text, assistantText)) {
        return { text: output.text, messageId: candidate.messageId };
      }
    }
  }
  return undefined;
}

function messageBody(call, threadId) {
  if (call.endpoint !== 'sendMessage' || call.body === null || typeof call.body !== 'object') {
    return undefined;
  }
  const body = call.body;
  if (body.message_thread_id !== threadId || typeof body.text !== 'string') return undefined;
  return { text: body.text };
}

function sameText(actual, expected) {
  return unescapeTelegramMarkdown(actual).trimEnd() === expected.trimEnd();
}
