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
  streamSwitcher: document.querySelector('#stream-switcher'),
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
let selectedStreamId = '';
let opening = false;
let stopping = false;
let running = false;
let approving = false;
let transientTimer = null;
const sessions = new Map();
const transientLines = [];
const seenEvents = new Set();

elements.token.value = clientToken;
renderTokenState();
setStatus(
  globalThis.navigator.onLine ? 'READY' : 'OFFLINE',
  globalThis.navigator.onLine ? 'idle' : 'bad',
);
refreshControls();
renderSwitcher();
renderStream();

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
  setStatus(selectedStreamId ? 'LIVE' : 'READY', selectedStreamId ? 'live' : 'idle');
  if (selectedStreamId) void hydrateStream(selectedStreamId);
});
globalThis.addEventListener('offline', () => setStatus('OFFLINE', 'bad'));

client.subscribe(0, onEvent, '*');

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
  const entry = sessions.get(selectedStreamId);
  elements.open.disabled = opening;
  elements.stop.disabled =
    !entry || entry.kind !== 'session' || entry.status !== 'running' || stopping;
  elements.run.disabled = running;
  elements.approve.disabled =
    !entry || entry.kind !== 'workflow' || entry.status !== 'running' || approving;
}

function streamKind(streamId) {
  if (streamId.startsWith('session:')) return 'session';
  if (streamId.startsWith('workflow:')) return 'workflow';
  return null;
}

function ensureEntry(streamId, label = '') {
  const kind = streamKind(streamId);
  if (!kind) return null;
  let entry = sessions.get(streamId);
  if (!entry) {
    entry = {
      stream_id: streamId,
      kind,
      label: label || (kind === 'session' ? 'session' : 'workflow'),
      status: 'running',
      lines: [],
    };
    sessions.set(streamId, entry);
    while (sessions.size > 20) {
      const oldest = sessions.keys().next().value;
      if (typeof oldest !== 'string') break;
      sessions.delete(oldest);
    }
  } else if (label) {
    entry.label = label;
  }
  return entry;
}

function shortId(streamId) {
  const id = streamId.slice(streamId.indexOf(':') + 1);
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function selectStream(streamId) {
  const entry = sessions.get(streamId);
  if (!entry) return;
  selectedStreamId = streamId;
  elements.streamCaption.textContent = streamId;
  renderSwitcher();
  renderStream();
  refreshControls();
  void hydrateStream(streamId);
}

function renderSwitcher() {
  elements.streamSwitcher.replaceChildren();
  for (const entry of [...sessions.values()].reverse()) {
    const chip = document.createElement('button');
    chip.className = 'stream-chip';
    chip.type = 'button';
    chip.dataset.active = entry.stream_id === selectedStreamId ? 'yes' : 'no';
    chip.dataset.status = entry.status;
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(entry.stream_id === selectedStreamId));
    chip.setAttribute('aria-label', `${entry.kind} ${entry.label} ${shortId(entry.stream_id)}`);
    chip.addEventListener('click', () => selectStream(entry.stream_id));

    const dot = document.createElement('span');
    dot.className = 'stream-chip__dot';
    dot.dataset.status = entry.status;
    dot.setAttribute('aria-hidden', 'true');
    chip.append(dot);

    const text = document.createElement('span');
    text.className = 'stream-chip__text';
    text.textContent = `${entry.kind} · ${entry.label} · ${shortId(entry.stream_id)}`;
    chip.append(text);
    elements.streamSwitcher.append(chip);
  }
}

function renderStream() {
  const entry = sessions.get(selectedStreamId);
  const lines = entry ? [...transientLines, ...entry.lines] : transientLines;
  const stickToBottom =
    elements.streamLines.scrollHeight -
      elements.streamLines.scrollTop -
      elements.streamLines.clientHeight <
    48;
  elements.streamLines.replaceChildren();
  if (!entry && lines.length === 0) {
    elements.streamEmpty.hidden = false;
    elements.streamLines.append(elements.streamEmpty);
    return;
  }
  elements.streamEmpty.hidden = true;
  for (const [index, item] of lines.entries()) {
    const line = document.createElement('li');
    line.className = `stream-line stream-line--${item.cls}`;
    const sequence = document.createElement('span');
    sequence.className = 'stream-line__seq';
    sequence.textContent = `#${index + 1}`;
    line.append(sequence);
    const text = document.createElement('span');
    text.className = 'stream-line__text';
    text.textContent = item.text;
    line.append(text);
    elements.streamLines.append(line);
  }
  if (stickToBottom) elements.streamLines.scrollTop = elements.streamLines.scrollHeight;
}

function pushLine(entry, cls, text) {
  entry.lines.push({ cls, text });
  if (entry.stream_id === selectedStreamId) renderStream();
}

function showTransientLine(cls, text) {
  transientLines.push({ cls, text });
  if (transientTimer !== null) globalThis.clearTimeout(transientTimer);
  transientTimer = globalThis.setTimeout(() => {
    transientLines.length = 0;
    transientTimer = null;
    renderStream();
  }, 6_000);
  renderStream();
}

function appendError(message, entry = sessions.get(selectedStreamId)) {
  const text = `${eventClock(new Date().toISOString())} error · ${message}`;
  if (entry) pushLine(entry, 'bad', text);
  else showTransientLine('bad', text);
}

function onEvent(event) {
  const key = `${event.stream_id}:${event.seq}`;
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  if (event.stream_id === 'admission') {
    if (event.type === 'session_throttled') {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
      const retry =
        typeof payload.retry_after_ms === 'number' ? ` · retry ${payload.retry_after_ms}ms` : '';
      showTransientLine(
        'bad',
        `${eventClock(event.ts)} session throttled · ${payload.provider ?? 'session'} · ${
          payload.reason ?? 'admission limit'
        }${retry}`,
      );
    }
    setStatus('LIVE', 'live');
    return;
  }
  const entry = ensureEntry(event.stream_id);
  if (!entry) {
    setStatus('LIVE', 'live');
    return;
  }
  applyEvent(entry, event);
  renderSwitcher();
  refreshControls();
  setStatus('LIVE', 'live');
}

function applyEvent(entry, event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  if (entry.kind === 'session') {
    if (event.type === 'session_started') {
      if (typeof payload.provider === 'string' && payload.provider.trim())
        entry.label = payload.provider;
      entry.status = 'running';
      pushEventLine(entry, event, 'ok');
      return;
    }
    if (event.type === 'session_output') {
      pushEventLine(entry, event, 'normal');
      return;
    }
    if (event.type === 'session_complete') {
      entry.status = 'done';
      pushEventLine(entry, event, 'ok');
      return;
    }
    if (event.type === 'verify_failed') {
      entry.status = 'failed';
      pushEventLine(entry, event, 'bad');
      return;
    }
    pushEventLine(entry, event, toneFor(event.type));
    return;
  }
  const template = templateFromPayload(payload);
  if (template) entry.label = template;
  pushEventLine(entry, event, toneFor(event.type));
  if (isWorkflowFailure(event.type)) entry.status = 'failed';
  else if (isWorkflowTerminal(event.type)) entry.status = 'done';
  else if (event.type === 'session_started') entry.status = 'running';
}

function pushEventLine(entry, event, tone) {
  pushLine(
    entry,
    tone,
    `${eventClock(event.ts)} ${event.type} · ${eventText(event.type, event.payload)}`,
  );
}

function templateFromPayload(payload) {
  if (typeof payload.template === 'string' && payload.template.trim()) return payload.template;
  if (typeof payload.template_name === 'string' && payload.template_name.trim())
    return payload.template_name;
  if (typeof payload.prompt === 'string' && payload.prompt.startsWith('workflow-template:'))
    return payload.prompt.slice('workflow-template:'.length) || 'workflow';
  return '';
}

function isWorkflowFailure(type) {
  return type === 'verify_failed' || /(?:fail|error|denied|rejected)/i.test(type);
}

function isWorkflowTerminal(type) {
  return (
    type === 'session_complete' ||
    /(?:complete|completed|done|released|succeeded|success)$/i.test(type)
  );
}

async function hydrateStream(streamId) {
  try {
    const events = await client.getEvents(streamId, 0);
    for (const event of events) onEvent(event);
    if (selectedStreamId === streamId) setStatus('LIVE', 'live');
  } catch (error) {
    const entry = sessions.get(streamId);
    appendError(`event stream unavailable: ${errorMessage(error)}`, entry);
    if (selectedStreamId === streamId) setStatus('EVENT ERROR', 'bad');
  }
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
  const serialized = JSON.stringify(payload);
  return serialized === undefined ? String(payload) : serialized;
}

async function openSession() {
  const provider = elements.provider.value.trim();
  const prompt = elements.prompt.value.trim();
  if (!provider || !prompt) {
    appendError('provider and prompt are required');
    return;
  }
  refreshClient();
  opening = true;
  setStatus('OPENING', 'wait');
  refreshControls();
  try {
    const result = await client.openSession({ provider, prompt });
    const entry = ensureEntry(result.stream_id, provider);
    if (!entry) throw new Error('session.open returned an invalid stream');
    selectStream(result.stream_id);
    setStatus('LIVE', 'live');
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
  const entry = sessions.get(selectedStreamId);
  if (!entry || entry.kind !== 'session' || entry.status !== 'running') return;
  refreshClient();
  const sessionId = entry.stream_id.slice('session:'.length);
  stopping = true;
  setStatus('STOPPING', 'wait');
  refreshControls();
  try {
    const result = await client.stopSession({ session_id: sessionId });
    entry.status = 'done';
    pushLine(
      entry,
      result.stopped ? 'ok' : 'meta',
      `${eventClock(new Date().toISOString())} session.stop · ${
        result.stopped ? `stopped ${sessionId}` : `session ${sessionId} was already stopped`
      }`,
    );
    setStatus(selectedStreamId ? 'LIVE' : 'READY', selectedStreamId ? 'live' : 'idle');
  } catch (error) {
    appendError(`session stop failed: ${errorMessage(error)}`, entry);
    setStatus('ERROR', 'bad');
  } finally {
    stopping = false;
    renderSwitcher();
    refreshControls();
  }
}

async function runWorkflow() {
  const template = 'basic-build';
  refreshClient();
  running = true;
  setStatus('STARTING WORKFLOW', 'wait');
  refreshControls();
  try {
    const result = await client.runWorkflow({ template });
    const entry = ensureEntry(result.stream_id, template);
    if (!entry) throw new Error('workflow.run returned an invalid stream');
    selectStream(result.stream_id);
    setStatus('LIVE', 'live');
  } catch (error) {
    appendError(`workflow run failed: ${errorMessage(error)}`);
    setStatus('ERROR', 'bad');
  } finally {
    running = false;
    refreshControls();
  }
}

async function approveWorkflow() {
  const entry = sessions.get(selectedStreamId);
  if (!entry || entry.kind !== 'workflow' || entry.status !== 'running') return;
  refreshClient();
  const streamId = entry.stream_id;
  approving = true;
  setStatus('APPROVING', 'wait');
  refreshControls();
  try {
    const result = await client.approve({ stream_id: streamId });
    if (result.status === 'released' || result.stage === 'release') entry.status = 'done';
    const tone = result.approved ? 'ok' : result.blocked ? 'wait' : 'bad';
    const reason = result.reason ? ` · ${result.reason}` : '';
    pushLine(
      entry,
      tone,
      `${eventClock(new Date().toISOString())} workflow.approve · ${result.status} · ${
        result.stage
      }${reason}`,
    );
    setStatus(result.blocked ? 'WAITING' : 'LIVE', result.blocked ? 'wait' : 'live');
  } catch (error) {
    appendError(`workflow approval failed: ${errorMessage(error)}`, entry);
    setStatus('APPROVAL ERROR', 'bad');
  } finally {
    approving = false;
    renderSwitcher();
    refreshControls();
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
