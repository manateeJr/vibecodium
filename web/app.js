/* global document */
import { createClient } from '/client.js';
import { eventClock } from '/lib/time.js';
import { createActions } from '/ui/actions.js';
import { createHistoryDrawer, createSettingsDrawer } from '/ui/drawers.js';
import { createProjectPicker } from '/ui/project-picker.js';
import { createProjectManager } from '/ui/project-manager.js';
import { createTranscriptView } from '/ui/transcript.js';
import { applySessionEvent } from '/ui/events.js';

const TOKEN_KEY = 'vibecodium.token';

const elements = {
  status: document.querySelector('#connection-status'),
  connection: document.querySelector('.connection'),
  streamCaption: document.querySelector('#stream-caption'),
  gitStatus: document.querySelector('#git-status'),
  streamSwitcher: document.querySelector('#stream-switcher'),
  streamLines: document.querySelector('#stream-lines'),
  streamEmpty: document.querySelector('#stream-empty'),
  jumpLatest: document.querySelector('#jump-latest'),
  projectSelector: document.querySelector('#project-selector'),
  quickActionsShell: document.querySelector('.quick-actions-shell'),
  quickActions: document.querySelector('#quick-actions'),
  quickActionsRefresh: document.querySelector('#quick-actions-refresh'),
  projectAdd: document.querySelector('#add-project'),
  projectFormShell: document.querySelector('#add-project-form'),
  projectForm: document.querySelector('#project-form'),
  projectPath: document.querySelector('#project-path'),
  projectDescription: document.querySelector('#project-description'),
  projectDetect: document.querySelector('#detect-project'),
  projectSave: document.querySelector('#save-project'),
  projectCancel: document.querySelector('#cancel-project'),
  projectStatus: document.querySelector('#project-status'),
  projectProposals: document.querySelector('#project-proposals'),
  managedProjects: document.querySelector('#managed-projects'),
  promptForm: document.querySelector('#prompt-form'),
  projectFilter: document.querySelector('#project-filter'),
  workspace: document.querySelector('#workspace'),
  recentProjects: document.querySelector('#recent-projects'),
  prompt: document.querySelector('#prompt'),
  turnForm: document.querySelector('#turnForm'),
  turnInput: document.querySelector('#turnInput'),
  turnSend: document.querySelector('#send-turn'),
  open: document.querySelector('#open-session'),
  chatControls: document.querySelector('#chat-controls'),
  stop: document.querySelector('#stop-session'),
  tokenState: document.querySelector('#token-state'),
  token: document.querySelector('#capability-token'),
  harness: document.querySelector('#default-harness'),
  historyToggle: document.querySelector('#history-toggle'),
  historyDrawer: document.querySelector('#history-drawer'),
  historyClose: document.querySelector('#history-close'),
  historyScroll: document.querySelector('#history-scroll'),
  historySearch: document.querySelector('#history-search'),
  historyProjectFilter: document.querySelector('#history-project-filter'),
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
  scrollContainer: elements.historyScroll,
  searchInput: elements.historySearch,
  projectFilter: elements.historyProjectFilter,
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
const projectManager = createProjectManager({
  client,
  elements,
  errorMessage,
  onError: (message) => appendError(message),
  onProjectsChange: (nextProjects) => history.setProjects(nextProjects),
  onProjectChange: (project) => {
    if (project) projects.remember(project.path);
  },
  onQuickAction: (project, action) => void actions.openQuickAction(project, action),
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
});
const actions = createActions({
  client,
  elements,
  projects,
  sessions,
  state: actionState,
  getSelectedStreamId: () => selectedStreamId,
  getActiveProject: () => projectManager.selectedProject(),
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
void projectManager.load();
elements.promptForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void actions.openSession();
});
elements.turnForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void actions.sendMessage();
});
elements.stop.addEventListener('click', () => void actions.stopSession());
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
  elements.chatControls.hidden = !sessionLive;
  elements.open.disabled = actionState.opening;
  elements.stop.hidden = !sessionLive;
  elements.stop.disabled = !sessionLive || actionState.stopping;
  elements.turnForm.hidden = !sessionReady;
  elements.turnSend.disabled = !sessionReady || Boolean(entry?.busy);
}

function ensureEntry(streamId, label = '') {
  const kind = streamId.split(':', 1)[0];
  if (kind !== 'session') return null;
  let entry = sessions.get(streamId);
  if (!entry) {
    entry = {
      stream_id: streamId,
      kind,
      label: label || 'session',
      status: 'running',
      busy: false,
      lines: [],
      cwd: '',
      project: '',
      lastActivityAt: Date.now(),
    };
    sessions.set(streamId, entry);
  } else if (label) entry.label = label;
  return entry;
}

function openMachineSession(session) {
  const streamId = `machine:${session.source}:${session.ref}`;
  const updatedAt = Date.parse(session.updated_at);
  const entry = {
    stream_id: streamId,
    kind: 'session',
    label: session.title || session.ref,
    status: 'ready',
    busy: false,
    lines: [],
    cwd: session.cwd || '',
    project: '',
    resume: { source: session.source, ref: session.ref },
    updated_at: session.updated_at,
    lastActivityAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
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
  const recent = [...sessions.values()]
    .sort((left, right) => activityTime(right) - activityTime(left))
    .slice(0, 10);
  for (const entry of recent) {
    const id = entry.stream_id.split(':').pop() ?? '';
    const shortId = id.length > 8 ? `${id.slice(0, 8)}…` : id;
    const status = displayStatus(entry.status);
    const chip = document.createElement('button');
    chip.className = 'stream-chip';
    chip.type = 'button';
    chip.dataset.active = entry.stream_id === selectedStreamId ? 'yes' : 'no';
    chip.dataset.status = status;
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(entry.stream_id === selectedStreamId));
    chip.setAttribute('aria-label', `${entry.kind} ${entry.label} ${status}`);
    chip.addEventListener('click', () => selectStream(entry.stream_id));
    const dot = document.createElement('span');
    dot.className = 'stream-chip__dot';
    dot.dataset.status = status;
    dot.setAttribute('aria-hidden', 'true');
    chip.append(dot);
    const text = document.createElement('span');
    text.className = 'stream-chip__text';
    text.textContent = `${status} · ${entry.label} · ${shortId}`;
    chip.append(text);
    elements.streamSwitcher.append(chip);
  }
  history.renderLive(
    [...sessions.values()].filter(
      (entry) => entry.kind === 'session' && !entry.stream_id.startsWith('machine:'),
    ),
  );
}

function activityTime(entry) {
  if (Number.isFinite(entry.lastActivityAt)) return entry.lastActivityAt;
  const updatedAt = Date.parse(entry.updated_at ?? '');
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function displayStatus(status) {
  if (status === 'running') return 'live';
  if (status === 'failed' || status === 'throttled') return 'failed';
  return 'done';
}

function renderStream() {
  const entry = sessions.get(selectedStreamId);
  const canRestart =
    entry?.kind === 'session' && (entry.status === 'done' || entry.status === 'failed');
  transcript.render(
    entry ? [...transientLines, ...entry.lines] : transientLines,
    Boolean(entry?.busy),
    canRestart ? () => prepareRestart(entry) : undefined,
  );
}
function prepareRestart(entry) {
  if (entry.project) projectManager.selectProject(entry.project);
  else if (entry.cwd) projects.selectPath(entry.cwd);
  elements.prompt.focus();
  elements.prompt.scrollIntoView?.({ block: 'nearest' });
  showTransientLine(
    'meta',
    `new session ready · ${entry.cwd || '(default cwd)'} · harness ${elements.harness.value}`,
  );
}

function pushLine(entry, cls, text, markdown = false) {
  entry.lastActivityAt = Date.now();
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
  if (!entry) return;
  applySessionEvent(entry, event, pushLine);
  const eventTime = Date.parse(event.ts);
  entry.lastActivityAt = Number.isFinite(eventTime) ? eventTime : Date.now();
  renderSwitcher();
  renderStream();
  refreshControls();
  if (entry.stream_id === selectedStreamId) void updateGitStatus(entry);
  setStatus('LIVE', 'live');
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
