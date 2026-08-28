/* global document */

import { createClient } from '/client.js';

const TOKEN_KEY = 'vibecodium.token';
const EVENT_TONES = Object.freeze({
  session_started: 'ok',
  session_output: 'normal',
  session_complete: 'ok',
  verify_failed: 'bad',
  action_requested: 'wait',
  action_approved: 'ok',
  action_denied: 'bad',
  merge_to_main: 'ok',
  proposal_queued: 'wait',
  proposal_approved: 'ok',
  notify_emitted: 'meta',
  inbound_received: 'meta',
});

const elements = {
  status: document.querySelector('#connection-status'),
  connection: document.querySelector('.connection'),
  streamCaption: document.querySelector('#stream-caption'),
  streamLines: document.querySelector('#stream-lines'),
  streamEmpty: document.querySelector('#stream-empty'),
  promptForm: document.querySelector('#prompt-form'),
  provider: document.querySelector('#provider'),
  prompt: document.querySelector('#prompt'),
  open: document.querySelector('#open-session'),
  stop: document.querySelector('#stop-session'),
  run: document.querySelector('#run-workflow'),
  approve: document.querySelector('#approve-workflow'),
  token: document.querySelector('#capability-token'),
  tokenState: document.querySelector('#token-state'),
};

let clientToken = loadToken();
const clientOptions = {
  baseUrl: globalThis.location.origin,
  ...(clientToken ? { token: clientToken } : {}),
};
const client = createClient(clientOptions);
let activeStreamId = '';
let activeSessionId = '';
let workflowStreamId = '';
let unsubscribe = null;
let pollTimer = null;
let lastSequence = 0;
let opening = false;
let stopping = false;
let running = false;
let approving = false;
const seenEvents = new Set();

elements.token.value = clientToken;
renderTokenState();
setStatus(
  globalThis.navigator.onLine ? 'READY' : 'OFFLINE',
  globalThis.navigator.onLine ? 'idle' : 'bad',
);
refreshControls();

elements.promptForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void openSession();
});
elements.stop.addEventListener('click', () => void stopSession());
elements.run.addEventListener('click', () => void runWorkflow());
elements.approve.addEventListener('click', () => void approveWorkflow());
elements.token.addEventListener('input', () => {
  const value = elements.token.value.trim();
  saveToken(value);
  renderTokenState();
});
elements.token.addEventListener('change', () => refreshClient());
globalThis.addEventListener('online', () => {
  setStatus(activeStreamId ? 'LIVE' : 'READY', activeStreamId ? 'live' : 'idle');
  if (activeStreamId) void pollEvents(activeStreamId, true);
});
globalThis.addEventListener('offline', () => setStatus('OFFLINE', 'bad'));

function loadToken() {
  try {
    return (globalThis.localStorage.getItem(TOKEN_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

function saveToken(value) {
  try {
    if (value) globalThis.localStorage.setItem(TOKEN_KEY, value);
    else globalThis.localStorage.removeItem(TOKEN_KEY);
  } catch {
    setStatus('TOKEN UNSAVED', 'wait');
  }
}

function renderTokenState() {
  const isSet = Boolean(elements.token.value.trim());
  elements.tokenState.textContent = isSet ? 'set' : 'not set';
  elements.tokenState.dataset.set = isSet ? 'yes' : 'no';
}

function refreshClient() {
  const nextToken = elements.token.value.trim();
  if (nextToken === clientToken) return;
  clientToken = nextToken;
  if (nextToken) clientOptions.token = nextToken;
  else delete clientOptions.token;
}

function setStatus(label, tone) {
  elements.status.textContent = label;
  elements.connection.dataset.tone = tone;
}

function refreshControls() {
  elements.open.disabled = opening;
  elements.stop.disabled = !activeSessionId || stopping;
  elements.run.disabled = running;
  elements.approve.disabled = !workflowStreamId || approving;
}

function detachStream() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (pollTimer !== null) globalThis.clearInterval(pollTimer);
  pollTimer = null;
}

function attachStream(streamId) {
  detachStream();
  activeStreamId = streamId;
  lastSequence = 0;
  elements.streamCaption.textContent = streamId;
  setStatus('CONNECTING', 'wait');
  unsubscribe = client.subscribe(0, (event) => {
    if (event.stream_id !== streamId) return;
    appendEvent(event);
    setStatus('LIVE', 'live');
  });
  void pollEvents(streamId, true);
  pollTimer = globalThis.setInterval(() => void pollEvents(streamId, false), 2_000);
  refreshControls();
}

async function pollEvents(streamId, reportError) {
  if (streamId !== activeStreamId) return;
  try {
    const events = await client.getEvents(streamId, lastSequence);
    if (streamId !== activeStreamId) return;
    for (const event of events) appendEvent(event);
    if (events.length > 0) setStatus('LIVE', 'live');
  } catch (error) {
    if (!reportError || streamId !== activeStreamId) return;
    appendError(`event stream unavailable: ${errorMessage(error)}`);
    setStatus('EVENT ERROR', 'bad');
  }
}

function appendEvent(event) {
  const key = `${event.stream_id}:${event.seq}`;
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  lastSequence = Math.max(lastSequence, event.seq);
  appendLine(
    event.seq,
    event.type,
    eventText(event.type, event.payload),
    toneFor(event.type),
    event.ts,
  );
  if (event.type === 'session_complete' && event.payload.session_id === activeSessionId) {
    activeSessionId = '';
    refreshControls();
  }
}

function appendLine(sequence, kind, text, tone, timestamp) {
  elements.streamEmpty.hidden = true;
  const stickToBottom =
    elements.streamLines.scrollHeight -
      elements.streamLines.scrollTop -
      elements.streamLines.clientHeight <
    48;
  const line = document.createElement('li');
  line.className = `stream-line stream-line--${tone}`;
  line.dataset.kind = kind;

  const sequenceNode = document.createElement('span');
  sequenceNode.className = 'stream-line__seq';
  sequenceNode.textContent = sequence === '—' ? '—' : `#${sequence}`;
  line.append(sequenceNode);

  const kindNode = document.createElement('span');
  kindNode.className = 'stream-line__kind';
  kindNode.textContent = `${eventClock(timestamp)} ${kind}`;
  line.append(kindNode);

  const textNode = document.createElement('span');
  textNode.className = 'stream-line__text';
  textNode.textContent = text;
  line.append(textNode);
  elements.streamLines.append(line);
  if (stickToBottom) elements.streamLines.scrollTop = elements.streamLines.scrollHeight;
}

function appendError(message) {
  appendLine('—', 'error', message, 'bad', new Date().toISOString());
}

function eventClock(timestamp) {
  const date = new Date(timestamp ?? '');
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toneFor(type) {
  return EVENT_TONES[type] ?? 'meta';
}

function eventText(type, payload) {
  const value = payload && typeof payload === 'object' ? payload : {};
  if (type === 'session_output' && typeof value.text === 'string') return value.text;
  if (type === 'session_started')
    return `${value.provider ?? 'session'} · ${value.prompt ?? ''}`.trim();
  if (type === 'session_complete') return `session ${value.session_id ?? ''} complete`.trim();
  if (type === 'verify_failed') return `${value.stage ?? 'verify'}: ${value.error ?? 'failed'}`;
  if (type === 'action_requested' || type === 'action_approved' || type === 'action_denied') {
    return `${value.action ?? 'action'} · request ${value.request_id ?? 'unknown'}`;
  }
  if (type === 'merge_to_main')
    return `${value.branch ?? 'branch'} · ${value.commit_sha ?? ''}`.trim();
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

async function openSession() {
  const provider = elements.provider.value.trim();
  const prompt = elements.prompt.value.trim();
  if (!provider || !prompt) {
    appendError('provider and prompt are required');
    return;
  }
  if (activeSessionId) {
    appendError('stop the active session before opening another');
    return;
  }
  refreshClient();
  opening = true;
  setStatus('OPENING', 'wait');
  refreshControls();
  try {
    const result = await client.openSession({ provider, prompt });
    activeSessionId = result.session_id;
    appendLine(
      '—',
      'session.open',
      `${provider} · ${result.session_id}`,
      'meta',
      new Date().toISOString(),
    );
    attachStream(result.stream_id);
    elements.prompt.value = '';
  } catch (error) {
    appendError(`session open failed: ${errorMessage(error)}`);
    setStatus('ERROR', 'bad');
  } finally {
    opening = false;
    refreshControls();
  }
}

async function stopSession() {
  if (!activeSessionId) return;
  refreshClient();
  const sessionId = activeSessionId;
  stopping = true;
  setStatus('STOPPING', 'wait');
  refreshControls();
  try {
    const result = await client.stopSession({ session_id: sessionId });
    activeSessionId = '';
    appendLine(
      '—',
      'session.stop',
      result.stopped ? `stopped ${sessionId}` : `session ${sessionId} was already stopped`,
      result.stopped ? 'ok' : 'meta',
      new Date().toISOString(),
    );
    setStatus(activeStreamId ? 'LIVE' : 'READY', activeStreamId ? 'live' : 'idle');
  } catch (error) {
    appendError(`session stop failed: ${errorMessage(error)}`);
    setStatus('ERROR', 'bad');
  } finally {
    stopping = false;
    refreshControls();
  }
}

async function runWorkflow() {
  refreshClient();
  running = true;
  setStatus('STARTING WORKFLOW', 'wait');
  refreshControls();
  try {
    const result = await client.runWorkflow({ template: 'basic-build' });
    workflowStreamId = result.stream_id;
    appendLine(
      '—',
      'workflow.run',
      `basic-build · ${result.stream_id}`,
      'meta',
      new Date().toISOString(),
    );
    attachStream(result.stream_id);
  } catch (error) {
    appendError(`workflow run failed: ${errorMessage(error)}`);
    setStatus('ERROR', 'bad');
  } finally {
    running = false;
    refreshControls();
  }
}

async function approveWorkflow() {
  if (!workflowStreamId) return;
  refreshClient();
  approving = true;
  setStatus('APPROVING', 'wait');
  refreshControls();
  try {
    const result = await client.approve({ stream_id: workflowStreamId });
    const tone = result.approved ? 'ok' : result.blocked ? 'wait' : 'bad';
    const reason = result.reason ? ` · ${result.reason}` : '';
    appendLine(
      '—',
      'workflow.approve',
      `${result.status} · ${result.stage}${reason}`,
      tone,
      new Date().toISOString(),
    );
    setStatus(result.blocked ? 'WAITING' : 'LIVE', result.blocked ? 'wait' : 'live');
  } catch (error) {
    appendError(`workflow approval failed: ${errorMessage(error)}`);
    setStatus('APPROVAL ERROR', 'bad');
  } finally {
    approving = false;
    refreshControls();
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
