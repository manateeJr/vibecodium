import { createReplayRuntime, spawnTelegramBot, stopTelegramBot } from './runtime.mjs';
import {
  assistantTextForTurn,
  command,
  finalTelegramEdit,
  latestCompletedTurn,
  readEvents,
  readTranscript,
  sleep,
  transcriptPath,
  turnTextFromEvents,
  waitFor,
} from './io.mjs';
import { createStepRecord, evaluateExpectations, printStep, printTable } from './report.mjs';

const fakeTimeoutMs = 30_000;
const ompTimeoutMs = 180_000;

export async function runReplay(options) {
  const { script, provider, keep, strictEcho, telegram } = options;
  const ids = {
    userId: telegram.USER_ID,
    chatId: telegram.CHAT_ID,
    threadId: telegram.THREAD_ID,
  };
  const timeoutMs = provider === 'fake' ? fakeTimeoutMs : ompTimeoutMs;
  const context = createReplayRuntime({ project: script.project, provider });
  const controller = new globalThis.AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const records = [];
  const failures = [];
  const state = {
    sessionId: undefined,
    lastTurn: 0,
    telegramText: undefined,
    transcriptTurns: 0,
    transcriptText: undefined,
  };
  let stub;
  let bot;
  let stdout = '';
  let stderr = '';
  let updateId = 1;
  let messageId = 10;
  let kept = false;

  try {
    // Keep the first runtime's reaper dormant until the explicit deterministic pass below.
    await context.startRuntime(false, 600);
    stub = await telegram.startTelegramStub([], {
      userId: ids.userId,
      chatId: ids.chatId,
      threadId: ids.threadId,
    });
    bot = spawnTelegramBot(context, stub.port, ids);
    bot.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    bot.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    await waitFor(
      'Telegram startup',
      () => {
        if (bot.exitCode !== null) {
          throw new Error(`Telegram bot exited before startup: ${stderr.trim()}`);
        }
        return stdout.includes('Telegram bot @e2e_bot started');
      },
      {
        timeoutMs,
        signal: controller.signal,
        onTimeout: () => printTimeoutDiagnostics(context),
      },
    );

    for (const [index, step] of script.steps.entries()) {
      const stepNumber = index + 1;
      if (step.expect !== undefined) {
        evaluateExpectations(step.expect, state, failures);
        continue;
      }
      if (step.via === 'telegram') {
        await replayTelegramStep({
          context,
          stub,
          telegram,
          ids,
          step,
          stepNumber,
          state,
          updateId: () => updateId++,
          messageId: () => messageId++,
          timeoutMs,
          signal: controller.signal,
          records,
          strictEcho,
        });
        continue;
      }
      if (step.via === 'terminal') {
        await replayTerminalStep({
          context,
          stub,
          step,
          stepNumber,
          state,
          timeoutMs,
          signal: controller.signal,
          records,
          strictEcho,
          failures,
        });
        continue;
      }
      await replayReapStep({
        context,
        stepNumber,
        state,
        timeoutMs,
        signal: controller.signal,
        records,
      });
    }
    printTable(records);
    if (failures.length > 0) throw new Error(failures.join('\n'));
    if (keep) {
      kept = true;
      printKeepInstructions(context, state.sessionId);
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (!kept) {
      await stopTelegramBot(bot).catch((error) => {
        globalThis.console.error(`[replay] bot cleanup failed: ${error.message}`);
      });
      if (stub !== undefined) {
        await stub.close().catch((error) => {
          globalThis.console.error(`[replay] Telegram stub cleanup failed: ${error.message}`);
        });
      }
      await context.cleanup().catch((error) => {
        globalThis.console.error(`[replay] runtime cleanup failed: ${error.message}`);
      });
    }
  }
}

async function replayTelegramStep({
  context,
  stub,
  telegram,
  ids,
  step,
  stepNumber,
  state,
  updateId,
  messageId,
  timeoutMs,
  signal,
  records,
}) {
  const startedAt = Date.now();
  const fromCall = stub.calls.length;
  const previousEvents =
    state.sessionId === undefined ? [] : await readEvents(context.runtime, state.sessionId);
  const previousMaxSeq = previousEvents.reduce(
    (latest, event) => Math.max(latest, event.seq ?? 0),
    0,
  );
  const topic = state.sessionId !== undefined;
  stub.enqueue(
    telegram.messageUpdate(updateId(), messageId(), step.text, topic, {
      userId: ids.userId,
      chatId: ids.chatId,
      threadId: ids.threadId,
    }),
  );
  if (state.sessionId === undefined) {
    const session = await waitFor(
      'Telegram session.open',
      async () => {
        const result = await command(context.runtime, 'session.list');
        if (!Array.isArray(result?.sessions)) throw new Error('session.list omitted sessions');
        return result.sessions.find(
          (candidate) =>
            candidate.project === context.projectName ||
            (candidate.provider === context.providerName && candidate.status === 'live'),
        );
      },
      {
        timeoutMs,
        signal,
        onTimeout: () => printTimeoutDiagnostics(context),
      },
    );
    state.sessionId = session.session_id;
  }
  const turn = state.lastTurn + 1;
  await waitFor(
    `Telegram turn_complete ${state.sessionId}`,
    async () => {
      const events = await readEvents(context.runtime, state.sessionId);
      return events.some(
        (event) => event?.type === 'turn_complete' && (event.seq ?? 0) > previousMaxSeq,
      );
    },
    {
      timeoutMs,
      signal,
      onTimeout: () => printTimeoutDiagnostics(context, state.sessionId),
    },
  );
  const final = await waitFor(
    `Telegram final edit turn=${turn}`,
    () => finalTelegramEdit(stub.calls, fromCall),
    {
      timeoutMs,
      signal,
      onTimeout: () => printTimeoutDiagnostics(context, state.sessionId),
    },
  );
  const capture = await captureSession(context, state.sessionId, turn, timeoutMs, signal);
  state.lastTurn = turn;
  state.telegramText = final.text;
  state.transcriptTurns = capture.transcript.turns.length;
  state.transcriptText = capture.transcriptText;
  const record = createStepRecord(stepNumber, {
    turn,
    latencyMs: Date.now() - startedAt,
    telegramText: final.text,
    telegramMessageId: final.messageId,
    transcriptText: capture.transcriptText,
    transcriptExists: capture.transcript.exists,
    transcriptTurns: state.transcriptTurns,
    eventCount: capture.events.length,
  });
  records.push(record);
  printStep(record, false);
}

async function replayTerminalStep({
  context,
  stub,
  step,
  stepNumber,
  state,
  timeoutMs,
  signal,
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
      {
        timeoutMs,
        signal,
        onTimeout: () => printTimeoutDiagnostics(context, state.sessionId),
      },
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
  const capture = await captureSession(context, state.sessionId, turn, timeoutMs, signal);
  const echo = finalTelegramEdit(stub.calls, fromCall);
  const transcriptText = turn === undefined ? undefined : capture.transcriptText;
  state.lastTurn = turn ?? state.lastTurn;
  if (echo !== undefined) state.telegramText = echo.text;
  state.transcriptTurns = capture.transcript.turns.length;
  if (transcriptText !== undefined) state.transcriptText = transcriptText;
  if (strictEcho && turn !== undefined && echo === undefined) {
    failures.push(
      `[expect] FAIL echo expected terminal turn ${turn} in Telegram; actual echo: pending #113`,
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
  printStep(record, strictEcho);
  if (eventText !== undefined && eventText !== transcriptText) {
    globalThis.console.log(`[terminal] step=${stepNumber} event text differs from transcript text`);
  }
}

async function replayReapStep({ context, stepNumber, state, timeoutMs, signal, records }) {
  if (state.sessionId === undefined) throw new Error('reap step has no Telegram session');
  const startedAt = Date.now();
  const runtimeBeforeReap = context.runtime;
  await sleep(750);
  await runtimeBeforeReap.sessions.reapIdle();
  const proof = await waitFor(
    'idle reaper session_state resumable/reaped',
    async () => {
      const events = await readEvents(runtimeBeforeReap, state.sessionId);
      return events.find(
        (event) =>
          event?.type === 'session_state' &&
          event.payload?.session_id === state.sessionId &&
          event.payload?.reason === 'reaped',
      );
    },
    {
      timeoutMs,
      signal,
      onTimeout: () => printTimeoutDiagnostics(context, state.sessionId),
    },
  );
  const liveSubstrate = await runtimeBeforeReap.substrate.listSessions();
  if (liveSubstrate.some((entry) => entry.name === `substrate-${state.sessionId}` && entry.live)) {
    throw new Error('idle reaper proof arrived while substrate session remained live');
  }
  const events = await readEvents(runtimeBeforeReap, state.sessionId);
  const transcript = readTranscript(transcriptPath(context.runtime, state.sessionId));
  if (transcript.turns.at(-1)?.text !== undefined) {
    state.transcriptText = transcript.turns.at(-1).text;
  }
  const proofText = `reap: observed session_state state=${proof.payload.state} reason=${proof.payload.reason}; restarted same port ${context.port}`;
  globalThis.console.log(`[reap] ${proofText}`);
  await context.stopRuntime(runtimeBeforeReap);
  await context.startRuntime(false);
  const record = createStepRecord(stepNumber, {
    turn: undefined,
    latencyMs: Date.now() - startedAt,
    transcriptText: transcript.turns.at(-1)?.text,
    transcriptExists: transcript.exists,
    transcriptTurns: transcript.turns.length,
    eventCount: events.length,
    reaperProof: proofText,
  });
  records.push(record);
  state.transcriptTurns = transcript.turns.length;
  printStep(record, false);
}

async function captureSession(context, sessionId, turn, timeoutMs, signal) {
  const events = await readEvents(context.runtime, sessionId);
  const filePath = transcriptPath(context.runtime, sessionId);
  const transcript = await waitFor(
    `transcript ${sessionId}`,
    () => {
      const current = readTranscript(filePath);
      return turn === undefined || current.turns.length >= turn ? current : false;
    },
    {
      timeoutMs,
      signal,
      onTimeout: () => printTimeoutDiagnostics(context, sessionId),
    },
  );
  return {
    events,
    transcript,
    transcriptText: turn === undefined ? undefined : assistantTextForTurn(transcript, turn),
  };
}

async function printTimeoutDiagnostics(context, sessionId) {
  const runtime = context.runtime;
  const filePath = sessionId === undefined ? '(no session)' : transcriptPath(runtime, sessionId);
  const transcript =
    sessionId === undefined ? { exists: false, records: [], turns: [] } : readTranscript(filePath);
  let events = [];
  let eventError;
  if (sessionId !== undefined) {
    try {
      events = await readEvents(runtime, sessionId);
    } catch (error) {
      eventError = error instanceof Error ? error.message : String(error);
    }
  }
  const kindCounts = new Map();
  for (const record of transcript.records) {
    kindCounts.set(record.kind, (kindCounts.get(record.kind) ?? 0) + 1);
  }
  const kinds =
    [...kindCounts.entries()].map(([kind, count]) => `${kind}:${count}`).join(',') || '(none)';
  const eventTypes =
    events
      .slice(-5)
      .map((event) => event?.type ?? '(unknown)')
      .join(',') || '(none)';
  globalThis.console.error(
    `[replay] timeout diagnostics transcript=${filePath} exists=${transcript.exists ? 'yes' : 'no'} records=${transcript.records.length} kinds=${kinds} turns=${transcript.turns.length} last_event_types=${eventTypes}${eventError === undefined ? '' : ` event_error=${eventError}`}`,
  );
}

function printKeepInstructions(context, sessionId) {
  globalThis.console.log(`[replay] keeping runtime root ${context.root}`);
  globalThis.console.log(`vibecodium attach ${sessionId ?? '(no session)'}`);
  globalThis.console.log(`VIBECODIUM_URL=http://127.0.0.1:${context.port}`);
  globalThis.console.log(`VIBECODIUM_DB_PATH=${context.databasePath}`);
  globalThis.console.log(`VIBECODIUM_PROJECTS_PATH=${context.projectsPath}`);
  globalThis.console.log(`VIBECODIUM_SESSION_STORAGE_ROOT=${context.storageRoot}`);
  globalThis.console.log(`VIBECODIUM_SHARED_DIR=${context.root}/shared`);
  globalThis.console.log(`ABDUCO_SOCKET_DIR=${context.socketDir}`);
}
