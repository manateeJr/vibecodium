import { createClient } from '/client.js';
import { externalEntry } from '/lib/external-session.js';
import { mergeSessionItems, sessionIdOf } from '/lib/session-items.js';
import { loadToken, saveToken } from '/lib/storage.js';
import { eventClock } from '/lib/time.js';
import { createActions } from '/ui/actions.js';
import { wireConnectivity } from '/ui/connectivity.js';
import { createHistoryDrawer, createSettingsDrawer } from '/ui/drawers.js';
import { queryElements } from '/ui/elements.js';
import { createFilesPanel } from '/ui/files.js';
import { createGitStatus } from '/ui/git-status.js';
import { createHostPanel } from '/ui/host-panel.js';
import { createProjectManager } from '/ui/project-manager.js';
import { createSessionBar } from '/ui/session-bar.js';
import { createSkillsPanel } from '/ui/skills.js';
import { createSessionSurface } from '/ui/session-surface.js';
import { createVoiceRecorder } from '/ui/voice.js';
import { applySessionEvent } from '/ui/events.js';

const SESSION_LIMIT = 10;
const SESSION_NOTE = 'recent sessions unavailable';

const elements = queryElements();
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
  forking: false,
  interrupting: false,
};
let machineLoading = false;
let sessionsLoading = false;
let transientTimer = null;
let remoteSessions = [];
let machineSessions = [];
let registeredProjects = [];
let scopePresets = [];
const sessions = new Map();
const transientLines = [];
const seenEvents = new Set();
const { transcript, sessionView } = createSessionSurface({
  // Read lazily so a token saved in Settings reaches the next mirror subscription.
  connection: () => ({ baseUrl: globalThis.location.origin, token: clientToken }),
  elements,
  // Ratified: "Steer now" escalates natively with escape; the separate stop control interrupts.
  onSteerNow: () => actions.sendKeys(sessions.get(selectedStreamId), ['escape']),
});
const gitStatus = createGitStatus({
  client,
  target: elements.gitStatus,
  isCurrent: (entry) => entry.stream_id === selectedStreamId,
});
const sessionBar = createSessionBar({
  bar: elements.sessionBar,
  presetRow: elements.sessionPresets,
  onNew: () => selectNew(),
  onSelect: (item) => selectSessionItem(item),
  onStop: () => void actions.stopSession(),
  onPreset: (preset) => selectPreset(preset),
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
    void actions.forkMachineSession(session);
    history.close();
  },
  onOpen: loadMachineSessions,
});
const projectManager = createProjectManager({
  client,
  elements,
  errorMessage,
  onError: (message) => appendError(message),
  onProjectsChange: (nextProjects) => {
    registeredProjects = [...nextProjects];
    history.setProjects(nextProjects);
  },
  onProjectChange: () => updateScope(),
});
const hostPanel = createHostPanel({
  client,
  elements,
  errorMessage,
  onError: (message) => appendError(message),
});
const settings = createSettingsDrawer({
  drawer: elements.settingsDrawer,
  toggle: elements.settingsToggle,
  closeButton: elements.settingsClose,
  token: elements.token,
  tokenState: elements.tokenState,
  harness: elements.harness,
  onTokenInput: (value) => commitToken(value),
  onTokenCommit: (value) => commitToken(value),
  onOpen: () => {
    void hostPanel.refresh();
    void skills.refresh();
  },
});
createVoiceRecorder({
  client,
  button: elements.voiceRecord,
  input: elements.composeInput,
  note: setComposeNote,
  onError: (message) => appendError(message),
  errorMessage,
});
const actions = createActions({
  client,
  elements,
  sessions,
  state: actionState,
  getSelectedStreamId: () => selectedStreamId,
  getActiveProject: () => projectManager.selectedProject(),
  setStatus,
  refreshControls,
  renderSessions,
  renderStream,
  selectStream,
  ensureEntry,
  pushLine,
  appendError,
  errorMessage,
  notify: setComposeNote,
  reloadSessions: loadSessions,
});
const files = createFilesPanel({
  client,
  elements,
  errorMessage,
  onError: (message) => appendError(message),
  note: setComposeNote,
  getSessionId: () => sessions.get(selectedStreamId)?.session_id ?? '',
  onOpen: () => {
    history.close();
    settings.close();
  },
});
const skills = createSkillsPanel({
  client,
  elements,
  errorMessage,
  onError: (message) => appendError(message),
  getProject: () => projectManager.selectedProject(),
  onPresetsChange: () => refreshPresets(),
  onPrompt: (prompt) => void actions.openPreset({ prompt }),
});
elements.historyToggle.addEventListener('click', () => {
  settings.close();
  files.close();
});
elements.settingsToggle.addEventListener('click', () => {
  history.close();
  files.close();
});
elements.composeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void actions.submitCompose();
});
elements.interruptKey.addEventListener('click', () => {
  void actions.sendKeys(sessions.get(selectedStreamId), ['interrupt'], 'interrupting');
});
setStatus(
  globalThis.navigator.onLine ? 'READY' : 'OFFLINE',
  globalThis.navigator.onLine ? 'idle' : 'bad',
);
refreshControls();
renderStream();
updateScope();
void boot();
wireConnectivity({
  setStatus,
  getSelected: () => selectedStreamId,
  hydrate: hydrateStream,
  reconnect: () => client.reconnect(),
});
client.subscribe(0, onEvent, '*');

// Projects come first: external sessions and adopted skills are both keyed off the project list.
async function boot() {
  await projectManager.load();
  refreshPresets();
  await Promise.all([skills.refresh(), loadMachineSessions()]);
}

function commitToken(value) {
  if (!saveToken(value)) setStatus('TOKEN UNSAVED', 'wait');
  refreshClient(value);
}

function refreshClient(value = elements.token.value.trim()) {
  if (value === clientToken) return;
  clientToken = value;
  if (value) clientOptions.token = value;
  else delete clientOptions.token;
}

// The machine's own sessions feed both the history drawer and the per-project session bar.
async function loadMachineSessions() {
  if (machineLoading) return;
  machineLoading = true;
  try {
    const result = await client.machineList();
    machineSessions = [...result.sessions];
    history.renderMachine(machineSessions);
  } catch (error) {
    machineSessions = [];
    history.renderMachine([]);
    appendError(`machine session list failed: ${errorMessage(error)}`);
  } finally {
    machineLoading = false;
    renderSessions();
  }
}

async function loadSessions() {
  if (sessionsLoading) return;
  sessionsLoading = true;
  const project = projectManager.selectedProject();
  try {
    const args = { limit: SESSION_LIMIT };
    if (project?.name) args.project = project.name;
    const result = await client.listSessions(args);
    remoteSessions = [...result.sessions];
    if (elements.composeNote.textContent.startsWith(SESSION_NOTE)) setComposeNote('');
  } catch (error) {
    remoteSessions = [];
    setComposeNote(`${SESSION_NOTE}: ${errorMessage(error)}`);
  } finally {
    sessionsLoading = false;
    renderSessions();
  }
}

function updateScope() {
  const project = projectManager.selectedProject();
  elements.scopePath.textContent = project?.path || '(default cwd)';
  refreshPresets();
  skills.render();
  void loadSessions();
  void loadMachineSessions();
}

// Presets are the project's adopted skills first, then its detected quick actions.
function refreshPresets() {
  const project = projectManager.selectedProject();
  scopePresets = [
    ...skills.presets(),
    ...(project?.quickActions ?? []).map((action) => ({
      kind: 'action',
      id: action.id,
      label: action.label,
      prompt: action.prompt,
      title: action.prompt,
    })),
  ];
  renderSessions();
}

function selectPreset(preset) {
  if (preset.kind === 'skill') {
    skills.invoke(preset.id);
    return;
  }
  void actions.openPreset(preset);
}

function setStatus(label, tone) {
  elements.status.textContent = label;
  elements.connection.dataset.tone = tone;
}

function setComposeNote(text) {
  elements.composeNote.textContent = text;
  elements.composeNote.hidden = !text;
}

function refreshControls() {
  const entry = sessions.get(selectedStreamId);
  const sendable =
    entry?.kind === 'session' && (entry.status === 'running' || entry.status === 'ready');
  elements.composeSend.textContent = sendable ? 'SEND' : 'OPEN';
  elements.composeSend.classList.toggle('button--send', sendable);
  elements.composeSend.classList.toggle('button--open', !sendable);
  elements.composeSend.disabled = actionState.opening || Boolean(sendable && entry?.busy);
  elements.composeInput.placeholder = composePlaceholder(entry, sendable);
  elements.interruptKey.disabled =
    actionState.opening || actionState.interrupting || !sendable || !sessionIdOf(entry);
  renderSessions();
}

function composePlaceholder(entry, sendable) {
  if (sendable) return 'Write something…';
  if (entry) return 'Continue in a new session…';
  return 'Describe a task to start a session…';
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

function selectNew() {
  selectedStreamId = '';
  elements.streamCaption.textContent = 'New session';
  gitStatus.hide();
  renderStream();
  refreshControls();
  elements.composeInput.focus();
  sessionView.selectSession('');
}

function selectSessionItem(item) {
  const existing = sessions.get(item.stream_id);
  const entry = existing ?? (item.external ? adoptExternalItem(item) : adoptSessionItem(item));
  if (!entry) return;
  selectStream(entry.stream_id);
}

// External sessions are read-only here: the machine owns them, and HISTORY still forks them.
function adoptExternalItem(item) {
  const entry = externalEntry(item);
  sessions.set(entry.stream_id, entry);
  return entry;
}

function adoptSessionItem(item) {
  const entry = ensureEntry(item.stream_id, item.provider);
  if (!entry) return null;
  if (item.session_id) entry.session_id = item.session_id;
  entry.status = item.status === 'live' ? 'running' : item.status === 'failed' ? 'failed' : 'done';
  entry.cwd = item.cwd || '';
  entry.project = item.project || '';
  entry.lastActivityAt = item.time || Date.now();
  return entry;
}

function selectStream(streamId) {
  const entry = sessions.get(streamId);
  if (!entry) return;
  selectedStreamId = streamId;
  elements.streamCaption.textContent = entry.label || streamId;
  renderStream();
  refreshControls();
  void gitStatus.update(entry);
  if (!streamId.startsWith('machine:')) void hydrateStream(streamId);
  elements.composeInput.focus();
  sessionView.selectSession(sessionIdOf(entry));
}

function renderSessions() {
  sessionBar.update({
    items: sessionItems(),
    selectedId: selectedStreamId,
    presets: scopePresets,
    stopping: actionState.stopping,
  });
  history.renderLive(
    [...sessions.values()].filter(
      (entry) => entry.kind === 'session' && !entry.stream_id.startsWith('machine:'),
    ),
  );
}

function sessionItems() {
  return mergeSessionItems({
    remote: remoteSessions,
    local: [...sessions.values()],
    machine: machineSessions,
    projects: registeredProjects,
    project: projectManager.selectedProject(),
    selectedId: selectedStreamId,
    limit: SESSION_LIMIT,
  });
}

function renderStream() {
  const entry = sessions.get(selectedStreamId);
  const canRestart =
    entry?.kind === 'session' &&
    (entry.status === 'done' || entry.status === 'failed' || entry.status === 'external');
  transcript.render(
    entry ? [...transientLines, ...entry.lines] : transientLines,
    Boolean(entry?.busy),
    canRestart ? () => prepareRestart(entry) : undefined,
  );
}
function prepareRestart(entry) {
  if (entry.project) projectManager.selectProject(entry.project);
  elements.composeInput.focus();
  elements.composeInput.scrollIntoView?.({ block: 'nearest' });
  showTransientLine(
    'meta',
    `new session ready · ${entry.cwd || '(default cwd)'} · harness ${elements.harness.value}`,
  );
}

function pushLine(entry, cls, text, markdown = false, metadata) {
  entry.lastActivityAt = Date.now();
  entry.lines.push({ cls, text, markdown, ...(metadata ?? {}) });
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
  renderStream();
  refreshControls();
  if (entry.stream_id === selectedStreamId) void gitStatus.update(entry);
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
