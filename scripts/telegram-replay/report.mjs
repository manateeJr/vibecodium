import { unescapeTelegramMarkdown } from './io.mjs';

export function createStepRecord(step, data) {
  return {
    step,
    turn: data.turn,
    latencyMs: data.latencyMs,
    telegramText: data.telegramText,
    telegramMessageId: data.telegramMessageId,
    transcriptText: data.transcriptText,
    transcriptExists: data.transcriptExists,
    transcriptTurns: data.transcriptTurns,
    eventCount: data.eventCount,
    reaperProof: data.reaperProof,
  };
}

export function printStep(record, strictEcho) {
  const turn = record.turn === undefined ? '—' : String(record.turn);
  const telegramText = record.telegramText;
  const telegramDetail =
    telegramText === undefined
      ? record.turn === undefined
        ? 'no new assistant post'
        : strictEcho
          ? 'echo missing'
          : 'echo: pending #113'
      : `text=${JSON.stringify(unescapeTelegramMarkdown(telegramText))} message_id=${record.telegramMessageId ?? '—'}`;
  const terminalDetail =
    record.reaperProof ??
    (record.transcriptText === undefined
      ? `no assistant text; events=${record.eventCount}`
      : `text=${JSON.stringify(record.transcriptText)} transcript_turns=${record.transcriptTurns}`);
  globalThis.console.log(
    `[telegram] step=${record.step} turn=${turn} ${telegramDetail} latency=${record.latencyMs}ms`,
  );
  globalThis.console.log(
    `[terminal] step=${record.step} turn=${turn} ${terminalDetail} latency=${record.latencyMs}ms`,
  );
}

export function evaluateExpectations(expect, state, failures) {
  for (const [surface, operator] of Object.entries(expect)) {
    const rawActual = surface === 'telegram' ? state.telegramText : state.transcriptTurns;
    const actual = typeof rawActual === 'string' ? unescapeTelegramMarkdown(rawActual) : rawActual;
    const result = evaluateOperator(operator, actual);
    const actualText = typeof actual === 'number' ? `turns:${actual}` : (actual ?? '(none)');
    if (result.ok) {
      globalThis.console.log(`[expect] PASS ${surface} ${operator}`);
    } else {
      const message = `[expect] FAIL ${surface} expected ${operator}; actual ${actualText}`;
      globalThis.console.log(message);
      failures.push(message);
    }
  }
}

export function printTable(records) {
  globalThis.console.log('');
  globalThis.console.log(
    '| step | surface | turn | posted-to-telegram? | in-transcript? | match | latency |',
  );
  globalThis.console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const record of records) {
    const turn = record.turn === undefined ? '—' : String(record.turn);
    const hasTelegram = record.telegramText !== undefined;
    const hasTranscript = record.transcriptText !== undefined;
    const match =
      record.turn === undefined
        ? '—'
        : hasTelegram
          ? compareTelegramToTranscript(record.telegramText, record.transcriptText)
          : 'echo: pending #113';
    const latency = `${record.latencyMs}ms`;
    globalThis.console.log(
      `| ${record.step} | telegram | ${turn} | ${hasTelegram ? 'yes' : 'no'} | ${hasTranscript ? 'yes' : 'no'} | ${match} | ${latency} |`,
    );
    globalThis.console.log(
      `| ${record.step} | terminal | ${turn} | ${hasTelegram ? 'yes' : 'no'} | ${hasTranscript ? 'yes' : 'no'} | ${match} | ${latency} |`,
    );
  }
}

export function compareTelegramToTranscript(telegramText, transcriptText) {
  if (transcriptText === undefined) return '!! MISMATCH (missing transcript) !!';
  return unescapeTelegramMarkdown(telegramText) === transcriptText ? 'OK' : '!! MISMATCH !!';
}

function evaluateOperator(operator, actual) {
  if (operator.startsWith('contains:')) {
    const expected = operator.slice('contains:'.length);
    return { ok: typeof actual === 'string' && actual.includes(expected) };
  }
  if (operator.startsWith('turns:')) {
    const expected = Number(operator.slice('turns:'.length));
    return { ok: Number.isInteger(expected) && actual === expected };
  }
  return { ok: false };
}
