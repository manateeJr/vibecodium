/* global document */
import { createClient } from '/client.js';
import { eventClock } from '/lib/time.js';
import { createActions } from '/ui/actions.js';
import { createHistoryDrawer, createSettingsDrawer } from '/ui/drawers.js';
import { createProjectPicker } from '/ui/project-picker.js';
import { createTranscriptView } from '/ui/transcript.js';

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
  gitStatus: document.querySelector('#git-status'),
  streamSwitcher: document.querySelector('#stream-switcher'),
  streamLines: document.querySelector('#stream-lines'),
  streamEmpty: document.querySelector('#stream-empty'),
  jumpLatest: document.querySelector('#jump-latest'),
  promptForm: document.querySelector('#prompt-form'),
  provider: document.querySelector('#provider'),
  projectFilter: document.querySelector('#project-filter'),
  workspace: document.querySelector('#workspace'),
  recentProjects: document.querySelector('#recent-projects'),
  prompt: document.querySelector('#prompt'),
  turnForm: document.querySelector('#turnForm'),
  turnInput: document.querySelector('#turnInput'),
  turnSend: document.querySelector('#send-turn'),
  open: document.querySelector('#open-session'),
  stop: document.querySelector('#stop-session'),
  run: document.querySelector('#run-workflow'),
  approve: document.querySelector('#approve-workflow'),
  token: document.querySelector('#capability-token'),
  tokenState: document.querySelector('#token-state'),
  harness: document.querySelector('#default-harness'),
  historyToggle: document.querySelector('#history-toggle'),
  historyDrawer: document.querySelector('#history-drawer'),
  historyClose: document.querySelector('#history-close'),
  liveHistory: document.querySelector('#live-history'),
  machineHistory: document.querySelector('#machine-history'),
  settingsToggle: document.querySelector('#settings-toggle'),
  settingsDrawer: document.querySelector('#settings-drawer'),
  settingsClose: document.querySelector('#settings-close'),
};
let clientToken = loadToken();
const clientOptions = {
  baseUrl: globalThis.location.origin,
  ...(clientToken ? { token: clientToken } : {}),
};
const client = createClient(clientOptions);
let selectedStreamId = '';
const actionState = {
  opening: false,
  stopping: false,
  running: false,
  approving: false,
};
let machineLoading = false;
let gitRequest = 0;
let transientTimer = null;
const sessions = new Map();
const transientLines = [];
const seenEvents = new Set();
const transcript = createTranscriptView({
  streamLines: elements.streamLines,
  streamEmpty: elements.streamEmpty,
  jumpLatest: elements.jumpLatest,
});
const projects = createProjectPicker({
  filter: elements.projectFilter,
  select: elements.workspace,
  recent: elements.recentProjects,
  onChange: (path) => {
    if (path) void updateGitStatus(sessions.get(selectedStreamId));
  },
});
const history = createHistoryDrawer({
  drawer: elements.historyDrawer,
  toggle: elements.historyToggle,
  closeButton: elements.historyClose,
  liveList: elements.liveHistory,
  machineList: elements.machineHistory,
  onLiveSelect: (streamId) => {
    selectStream(streamId);
    history.close();
  },
  onMachineSelect: (session) => {
    openMachineSession(session);
    history.close();
  },
  onOpen: loadMachineSessions,
});
const settings = createSettingsDrawer({
  drawer: elements.settingsDrawer,
  toggle: elements.settingsToggle,
  closeButton: elements.settingsClose,
  token: elements.token,
  tokenState: elements.tokenState,
  harness: elements.harness,
  onTokenInput: (value) => {
    saveToken(value);
    refreshClient(value);
  },
  onTokenCommit: (value) => {
    saveToken(value);
    refreshClient(value);
  },
  onHarness: (value) => {
    elements.provider.value = value;
  },
});
const actions = createActions({
  client,
  elements,
  projects,
  sessions,
  state: actionState,
  getSelectedStreamId: () => selectedStreamId,
  setStatus,
  refreshControls,
  renderSwitcher,
  renderStream,
  selectStream,
  ensureEntry,
  pushLine,
  appendError,
  errorMessage,
});
elements.historyToggle.addEventListener('click', () => settings.close());
elements.settingsToggle.addEventListener('click', () => history.close());
setStatus(
  globalThis.navigator.onLine ? 'READY' : 'OFFLINE',
  globalThis.navigator.onLine ? 'idle' : 'bad',
);
refreshControls();
renderSwitcher();
renderStream();
void loadWorkspaces();
elements.promptForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void actions.openSession();
});
elements.turnForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void actions.sendMessage();
});
elements.stop.addEventListener('click', () => void actions.stopSession());
elements.run.addEventListener('click', () => void actions.runWorkflow());
elements.approve.addEventListener('click', () => void actions.approveWorkflow());
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

function refreshClient(value = elements.token.value.trim()) {
  if (value === clientToken) return;
  clientToken = value;
  if (value) clientOptions.token = value;
  else delete clientOptions.token;
}

async function loadWorkspaces() {
  try {
    const result = await client.listWorkspaces();
    projects.setWorkspaces(result.workspaces);
  } catch (error) {
    appendError(`workspace list failed: ${errorMessage(error)}`);
  }
}

async function loadMachineSessions() {
  if (machineLoading) return;
  machineLoading = true;
  try {
    const result = await client.machineList();
    history.renderMachine(result.sessions);
  } catch (error) {
    history.renderMachine([]);
    appendError(`machine session list failed: ${errorMessage(error)}`);
  } finally {
    machineLoading = false;
  }
}

function setStatus(label, tone) {
  elements.status.textContent = label;
  elements.connection.dataset.tone = tone;
}

function refreshControls() {
  const entry = sessions.get(selectedStreamId);
  const sessionReady =
    entry?.kind === 'session' && (entry.status === 'running' || entry.status === 'ready');
  const sessionLive = entry?.kind === 'session' && entry.status === 'running';
  elements.open.disabled = actionState.opening;
  elements.stop.disabled = !sessionLive || actionState.stopping;
  elements.turnForm.hidden = !sessionReady;
  elements.turnSend.disabled = !sessionReady || Boolean(entry?.busy);
  elements.run.disabled = actionState.running;
  elements.approve.disabled =
    !entry || entry.kind !== 'workflow' || entry.status !== 'running' || actionState.approving;
}

function ensureEntry(streamId, label = '') {
  const kind = streamId.split(':', 1)[0];
  if (kind !== 'session' && kind !== 'workflow') return null;
  let entry = sessions.get(streamId);
  if (!entry) {
    entry = {
      stream_id: streamId,
      kind,
      label: label || (kind === 'session' ? 'session' : 'workflow'),
      status: 'running',
      busy: false,
      lines: [],
      cwd: '',
    };
    sessions.set(streamId, entry);
    while (sessions.size > 20) {
      const oldest = sessions.keys().next().value;
      if (typeof oldest !== 'string') break;
      sessions.delete(oldest);
    }
  } else if (label) entry.label = label;
  return entry;
}

function openMachineSession(session) {
  const streamId = `machine:${session.source}:${session.ref}`;
  const entry = {
    stream_id: streamId,
    kind: 'session',
    label: session.title || session.ref,
    status: 'ready',
    busy: false,
    lines: [],
    cwd: session.cwd || '',
    resume: { source: session.source, ref: session.ref },
    updated_at: session.updated_at,
  };
  sessions.set(streamId, entry);
  selectStream(streamId);
}

function selectStream(streamId) {
  const entry = sessions.get(streamId);
  if (!entry) return;
  selectedStreamId = streamId;
  elements.streamCaption.textContent = entry.label || streamId;
  renderSwitcher();
  renderStream();
  refreshControls();
  void updateGitStatus(entry);
  if (!streamId.startsWith('machine:')) void hydrateStream(streamId);
}

function renderSwitcher() {
  elements.streamSwitcher.replaceChildren();
  for (const entry of [...sessions.values()].reverse()) {
    const id = entry.stream_id.split(':', 2)[1] ?? '';
    const shortId = id.length > 8 ? `${id.slice(0, 8)}…` : id;
    const chip = document.createElement('button');
    chip.className = 'stream-chip';
    chip.type = 'button';
    chip.dataset.active = entry.stream_id === selectedStreamId ? 'yes' : 'no';
    chip.dataset.status = entry.status;
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(entry.stream_id === selectedStreamId));
    chip.setAttribute('aria-label', `${entry.kind} ${entry.label} ${shortId}`);
    chip.addEventListener('click', () => selectStream(entry.stream_id));
    const dot = document.createElement('span');
    dot.className = 'stream-chip__dot';
    dot.dataset.status = entry.status;
    dot.setAttribute('aria-hidden', 'true');
    chip.append(dot);
    const text = document.createElement('span');
    text.className = 'stream-chip__text';
    text.textContent = `${entry.kind} · ${entry.label} · ${shortId}`;
    chip.append(text);
    elements.streamSwitcher.append(chip);
  }
  history.renderLive([...sessions.values()].filter((entry) => entry.kind === 'session'));
}

function renderStream() {
  const entry = sessions.get(selectedStreamId);
  transcript.render(
    entry ? [...transientLines, ...entry.lines] : transientLines,
    Boolean(entry?.busy),
  );
}

function pushLine(entry, cls, text, markdown = false) {
  entry.lines.push({ cls, text, markdown });
  if (entry.stream_id === selectedStreamId) renderStream();
}

function showTransientLine(cls, text) {
  transientLines.push({ cls, text, markdown: false });
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
  if (!entry) return setStatus('LIVE', 'live');
  applyEvent(entry, event);
  renderSwitcher();
  renderStream();
  refreshControls();
  if (entry.stream_id === selectedStreamId) void updateGitStatus(entry);
  setStatus('LIVE', 'live');
}

function applyEvent(entry, event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  if (typeof payload.session_id === 'string') entry.session_id = payload.session_id;
  if (typeof payload.cwd === 'string') entry.cwd = payload.cwd;
  const clock = eventClock(event.ts);
  if (entry.kind === 'session') {
    if (event.type === 'session_started') {
      if (typeof payload.provider === 'string' && payload.provider.trim())
        entry.label = payload.provider;
      entry.status = 'running';
      entry.busy = true;
      pushLine(entry, 'you', `${clock} you · ${payload.prompt ?? ''}`);
      pushLine(
        entry,
        'meta',
        `${clock} ${payload.provider ?? 'session'} · cwd ${payload.cwd ?? '(default cwd)'}`,
      );
      return;
    }
    if (event.type === 'session_input') {
      pushLine(entry, 'you', `${clock} you · ${payload.text ?? ''}`);
      return;
    }
    if (event.type === 'session_output') {
      pushLine(entry, 'agent', `${clock} agent · ${payload.text ?? ''}`, true);
      return;
    }
    if (event.type === 'turn_complete') {
      entry.busy = false;
      pushLine(entry, 'divider', `— turn ${payload.turn ?? '?'} —`);
      return;
    }
    if (event.type === 'session_complete' || event.type === 'verify_failed') {
      const failed = event.type === 'verify_failed';
      const text = failed
        ? `${payload.stage ?? 'verify'}: ${payload.error ?? 'failed'}`
        : 'session ended';
      entry.status = failed ? 'failed' : 'done';
      entry.busy = false;
      pushLine(entry, failed ? 'bad' : 'meta', `${clock} ${text}`);
      return;
    }
    pushEventLine(entry, event, EVENT_TONES[event.type] ?? 'meta');
    return;
  }
  const template = templateFromPayload(payload);
  if (template) entry.label = template;
  pushEventLine(entry, event, EVENT_TONES[event.type] ?? 'meta');
  if (event.type === 'verify_failed' || /(?:fail|error|denied|rejected)/i.test(event.type)) {
    entry.status = 'failed';
  } else if (
    event.type === 'session_complete' ||
    /(?:complete|completed|done|released|succeeded|success)$/i.test(event.type)
  ) {
    entry.status = 'done';
  } else if (event.type === 'session_started') entry.status = 'running';
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

async function updateGitStatus(entry) {
  const request = ++gitRequest;
  if (!entry?.cwd) {
    elements.gitStatus.hidden = true;
    return;
  }
  try {
    const result = await client.workspaceStatus({ path: entry.cwd });
    if (request !== gitRequest || selectedStreamId !== entry.stream_id) return;
    if (!result.branch || /no git|not git/i.test(result.branch)) {
      elements.gitStatus.hidden = true;
      return;
    }
    const cleanName =
      entry.cwd
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || entry.cwd;
    elements.gitStatus.textContent = `${cleanName} · ${result.branch} · ● ${result.dirty ? 'dirty' : 'clean'}`;
    elements.gitStatus.hidden = false;
  } catch {
    if (request === gitRequest) elements.gitStatus.hidden = true;
  }
}

function eventText(type, payload) {
  const value = payload && typeof payload === 'object' ? payload : {};
  if (type === 'action_requested' || type === 'action_approved' || type === 'action_denied')
    return `${value.action ?? 'action'} · request ${value.request_id ?? 'unknown'}`;
  if (type === 'merge_to_main')
    return `${value.branch ?? 'branch'} · ${value.commit_sha ?? ''}`.trim();
  return JSON.stringify(payload) ?? String(payload);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
