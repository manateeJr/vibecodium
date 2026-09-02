import fs from 'node:fs';
import path from 'node:path';
import { parseOmpTranscriptLine } from '../../dist/src/session/omp-record-parser.js';
import { ompHarnessPlugin } from '../../dist/src/provider/omp-harness-plugin.js';
export function sleep(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export async function readJson(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned HTTP ${response.status} with invalid JSON`);
  }
  if (!response.ok) {
    const detail = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return body;
}

export async function command(runtime, name, args = {}) {
  const response = await globalThis.fetch(`${runtime.address.httpUrl}/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await readJson(response, name);
  if (!body || typeof body !== 'object' || !('value' in body)) {
    throw new Error(`${name} response omitted value`);
  }
  return body.value;
}

export async function readEvents(runtime, sessionId) {
  const url = new globalThis.URL('/events', `${runtime.address.httpUrl}/`);
  url.searchParams.set('stream_id', `session:${sessionId}`);
  url.searchParams.set('from_seq', '0');
  const body = await readJson(await globalThis.fetch(url), 'events');
  if (!body || typeof body !== 'object' || !Array.isArray(body.events)) {
    throw new Error('events response omitted events');
  }
  return body.events;
}

export async function waitFor(description, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const signal = options.signal;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw new Error('replay interrupted');
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      if (typeof options.onTimeout === 'function') {
        try {
          await options.onTimeout();
        } catch (error) {
          globalThis.console.error(
            `[replay] timeout diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      throw new Error(`timed out waiting for ${description}`);
    }
    await sleep(options.intervalMs ?? 25);
  }
}

export function transcriptPath(runtime, sessionId) {
  const persisted = runtime.table?.get?.(sessionId)?.transcriptPath;
  if (typeof persisted === 'string' && persisted.length > 0) return persisted;
  const storageDir = path.join(runtime.storageRoot, sessionId);
  try {
    const transcript = fs
      .readdirSync(storageDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(storageDir, entry.name))
      .sort()
      .at(-1);
    if (transcript !== undefined) return transcript;
  } catch {
    // The canonical fallback is useful in timeout diagnostics before storage exists.
  }
  return path.join(storageDir, 'session.jsonl');
}

export function readTranscript(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, records: [], assistants: [], turns: [] };
  }
  const records = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try {
      const record = parseOmpTranscriptLine(line);
      if (record !== null) records.push(record);
    } catch {
      // A partial final line is ignored until the next capture.
    }
  }
  const assistants = records.filter((record) => record.kind === 'assistant');
  return {
    exists: true,
    records,
    assistants,
    turns: assistants.filter((record) => ompHarnessPlugin.idleDetector(record)),
  };
}

export function assistantTextForTurn(transcript, turn) {
  const record = transcript.turns[turn - 1];
  return typeof record?.text === 'string' ? record.text : undefined;
}

export function turnTextFromEvents(events, turn) {
  const complete = events.find(
    (event) => event?.type === 'turn_complete' && event.payload?.turn === turn,
  );
  if (!complete) return undefined;
  const input = events.find(
    (event) => event?.type === 'session_input' && event.payload?.turn === turn,
  );
  const startSeq = input?.seq ?? -1;
  return events
    .filter(
      (event) =>
        event?.type === 'session_output' &&
        event.payload?.session_id === complete.payload?.session_id &&
        event.seq > startSeq &&
        event.seq < complete.seq &&
        event.payload?.kind !== 'tool' &&
        typeof event.payload?.text === 'string',
    )
    .map((event) => event.payload.text)
    .join('');
}

export function latestCompletedTurn(events) {
  return events
    .filter((event) => event?.type === 'turn_complete' && typeof event.payload?.turn === 'number')
    .reduce((latest, event) => Math.max(latest, event.payload.turn), 0);
}

export function finalTelegramEdit(calls, fromIndex) {
  const edits = calls
    .slice(fromIndex)
    .filter((call) => call.endpoint === 'editMessageText')
    .filter((call) => {
      const body = call.body;
      return body && typeof body === 'object' && typeof body.text === 'string';
    });
  const final = edits.at(-1);
  if (!final || !final.body || typeof final.body !== 'object') return undefined;
  if (String(final.body.text).startsWith('working…')) return undefined;
  return {
    text: String(final.body.text),
    messageId: typeof final.body.message_id === 'number' ? final.body.message_id : undefined,
  };
}

export function unescapeTelegramMarkdown(text) {
  return text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
}
