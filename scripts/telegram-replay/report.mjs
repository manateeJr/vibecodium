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

export function printStep(record) {
  const turn = record.turn === undefined ? '—' : String(record.turn);
  const telegramText = record.telegramText;
  const telegramDetail =
    telegramText === undefined
      ? record.turn === undefined
        ? 'no new assistant post'
        : 'echo missing'
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
    if (surface === 'telegram' && operator === 'match:transcript') {
      const match = compareTelegramToTranscript(state.telegramText, state.transcriptText);
      if (match === 'OK') {
        globalThis.console.log(`[expect] PASS ${surface} ${operator}`);
      } else {
        const message = `[expect] FAIL ${surface} expected ${operator}; ${formatComparisonTexts(
          state.telegramText,
          state.transcriptText,
        )}`;
        globalThis.console.log(message);
        failures.push(message);
      }
      continue;
    }
    const rawActual =
      surface === 'telegram'
        ? state.telegramText
        : operator.startsWith('turns:')
          ? state.transcriptTurns
          : state.transcriptText;
    const actual =
      typeof rawActual === 'string' && surface === 'telegram'
        ? unescapeTelegramMarkdown(rawActual)
        : rawActual;
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
          : 'echo missing';
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
  if (telegramText === undefined) return '!! MISMATCH (missing Telegram text) !!';
  if (transcriptText === undefined) return '!! MISMATCH (missing transcript) !!';
  return normalizeComparisonText(telegramText, true) ===
    normalizeComparisonText(transcriptText, false)
    ? 'OK'
    : '!! MISMATCH !!';
}

function normalizeComparisonText(text, isTelegram) {
  return (isTelegram ? unescapeTelegramMarkdown(text) : text).trimEnd();
}

function formatComparisonTexts(telegramText, transcriptText) {
  const telegram = telegramText === undefined ? '(none)' : telegramText;
  const transcript = transcriptText === undefined ? '(none)' : transcriptText;
  return `telegram=${JSON.stringify(telegram)} transcript=${JSON.stringify(transcript)}`;
}

function evaluateOperator(operator, actual) {
  if (operator.startsWith('contains:')) {
    const expected = operator.slice('contains:'.length).toLowerCase();
    return { ok: typeof actual === 'string' && actual.toLowerCase().includes(expected) };
  }
  if (operator.startsWith('turns:')) {
    const expected = Number(operator.slice('turns:'.length));
    return { ok: Number.isInteger(expected) && actual === expected };
  }
  return { ok: false };
}
