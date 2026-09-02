import {
  command,
  finalTelegramEdit,
  latestCompletedTurn,
  readEvents,
  sleep,
  unescapeTelegramMarkdown,
  waitFor,
} from './io.mjs';
import { captureSession } from './capture.mjs';
import { createStepRecord, printStep } from './report.mjs';

export async function replayOpenStep({ context, step, stepNumber, state }) {
  if (state.sessionId !== undefined)
    throw new Error('open step cannot replace an existing session');
  const args = {
    provider: context.providerName,
    cwd: context.projectPath,
    project: context.projectName,
    ...(step.prompt === undefined ? {} : { prompt: step.prompt }),
  };
  const opened = await command(context.runtime, 'session.open', args);
  if (typeof opened?.session_id !== 'string' || typeof opened?.stream_id !== 'string') {
    throw new Error('session.open omitted session identifiers');
  }
  state.sessionId = opened.session_id;
  state.lastTurn = 0;
  globalThis.console.log(
    `[open] step=${stepNumber} session=${opened.session_id} provider=${context.providerName} via=control-plane`,
  );
}

export async function replayBindStep({
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
  onTimeout,
  records,
}) {
  if (state.sessionId === undefined) throw new Error('bind step has no open session');
  const sessionId = state.sessionId;
  const choiceStart = stub.calls.length;
  stub.enqueue(
    telegram.messageUpdate(updateId(), messageId(), '/sessions', false, {
      userId: ids.userId,
      chatId: ids.chatId,
      threadId: ids.threadId,
    }),
  );
  const choice = await waitFor(
    `Telegram /sessions bind choice for ${sessionId}`,
    () => findBindChoice(stub.calls, choiceStart, sessionId),
    { timeoutMs, signal, onTimeout },
  );
  if (choice.call.messageId === undefined) throw new Error('/sessions reply omitted message id');
  stub.enqueue(
    telegram.callbackQueryUpdate(
      updateId(),
      `replay-bind-${stepNumber}`,
      choice.callbackData,
      choice.call.messageId,
      false,
      { userId: ids.userId, chatId: ids.chatId, threadId: ids.threadId },
    ),
  );
  const boundReply = await waitFor(
    `Telegram bind confirmation for ${sessionId}`,
    () => findTextCall(stub.calls, choiceStart, `bound to session ${sessionId}`),
    { timeoutMs, signal, onTimeout },
  );
  const topicCall = stub.calls
    .slice(choiceStart)
    .find((call) => call.endpoint === 'createForumTopic');
  if (topicCall === undefined)
    throw new Error(`bind did not create a forum topic for ${sessionId}`);
  globalThis.console.log(
    `[bind] session=${sessionId} callback=${choice.callbackData} topic-thread=${ids.threadId} reply=${JSON.stringify(boundReply.text)}`,
  );
  const startedAt = Date.now();
  const turnStart = stub.calls.length;
  await sleep(5_000);
  const beforeEvents = await readEvents(context.runtime, sessionId);
  stub.enqueue(
    telegram.messageUpdate(updateId(), messageId(), step.text, true, {
      userId: ids.userId,
      chatId: ids.chatId,
      threadId: ids.threadId,
    }),
  );
  const working = await waitFor(
    `bound topic progress for ${sessionId}`,
    () => findWorkingCall(stub.calls, turnStart, ids.threadId),
    { timeoutMs, signal, onTimeout },
  );
  const turn = await waitFor(
    `bound topic turn for ${sessionId}`,
    async () => {
      const events = await readEvents(context.runtime, sessionId);
      const latest = latestCompletedTurn(events);
      return latest > latestCompletedTurn(beforeEvents) ? latest : false;
    },
    { timeoutMs, signal, onTimeout },
  );
  const capture = await captureSession({
    runtime: context.runtime,
    sessionId,
    turn,
    timeoutMs,
    signal,
    onTimeout,
  });
  const reply = await waitFor(
    `bound topic assistant reply for ${sessionId}`,
    () => {
      const candidate = finalTelegramEdit(stub.calls, turnStart);
      return candidate === undefined || candidate.messageId !== working.messageId
        ? false
        : candidate;
    },
    { timeoutMs, signal, onTimeout },
  );
  const assistantText = capture.transcriptText;
  if (assistantText === undefined)
    throw new Error(`bound topic turn ${turn} omitted assistant text`);
  if (unescapeTelegramMarkdown(reply.text).trimEnd() !== assistantText.trimEnd()) {
    throw new Error(`bound topic turn ${turn} reply differs from transcript`);
  }
  globalThis.console.log(
    `[bind] session=${sessionId} thread=${ids.threadId} turn=${turn} assistant=${JSON.stringify(unescapeTelegramMarkdown(reply.text))}`,
  );
  state.lastTurn = turn;
  state.telegramText = reply.text;
  state.transcriptTurns = capture.transcript.turns.length;
  state.transcriptText = assistantText;
  const record = createStepRecord(stepNumber, {
    turn,
    latencyMs: Date.now() - startedAt,
    telegramText: reply.text,
    telegramMessageId: reply.messageId,
    transcriptText: assistantText,
    transcriptExists: capture.transcript.exists,
    transcriptTurns: state.transcriptTurns,
    eventCount: capture.events.length,
  });
  records.push(record);
  printStep(record);
}

function findBindChoice(calls, fromIndex, sessionId) {
  for (const call of calls.slice(fromIndex)) {
    if (call.endpoint !== 'sendMessage' || call.body === null || typeof call.body !== 'object')
      continue;
    const body = call.body;
    if (typeof body.text !== 'string' || !body.text.includes(sessionId)) continue;
    const callbackData = findBindCallback(body.reply_markup);
    if (callbackData !== undefined) return { call, callbackData };
  }
  return undefined;
}

function findBindCallback(markup) {
  if (markup === null || typeof markup !== 'object') return undefined;
  const keyboard = markup.inline_keyboard;
  if (!Array.isArray(keyboard)) return undefined;
  for (const row of keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (button === null || typeof button !== 'object') continue;
      const data = button.callback_data;
      if (typeof data === 'string' && /^bind:\d+:\d+$/.test(data)) return data;
    }
  }
  return undefined;
}

function findTextCall(calls, fromIndex, text) {
  for (const call of calls.slice(fromIndex)) {
    if (call.endpoint !== 'sendMessage' || call.body === null || typeof call.body !== 'object')
      continue;
    if (call.body.text === text) return { text };
  }
  return undefined;
}

function findWorkingCall(calls, fromIndex, threadId) {
  for (const call of calls.slice(fromIndex)) {
    if (call.endpoint !== 'sendMessage' || call.body === null || typeof call.body !== 'object')
      continue;
    if (call.body.message_thread_id !== threadId || typeof call.body.text !== 'string') continue;
    if (call.body.text.startsWith('working…')) return { messageId: call.messageId };
  }
  return undefined;
}
