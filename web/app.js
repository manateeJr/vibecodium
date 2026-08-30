import { createClient } from '/client.js';
import { externalEntry } from '/lib/external-session.js';
import { mergeSessionItems, sessionIdOf } from '/lib/session-items.js';
import {
  loadShowAgentSessions,
  loadToken,
  saveShowAgentSessions,
  saveToken,
} from '/lib/storage.js';
import { createActions } from '/ui/actions.js';
import { createComposer } from '/ui/composer.js';
import { wireConnectivity } from '/ui/connectivity.js';
import { createHistoryDrawer, createSettingsDrawer } from '/ui/drawers.js';
import { queryElements } from '/ui/elements.js';
import { createEventFeed } from '/ui/event-feed.js';
import { createFilesPanel } from '/ui/files.js';
import { createGitStatus } from '/ui/git-status.js';
import { createHostPanel } from '/ui/host-panel.js';
import { createModelPicker } from '/ui/model-picker.js';
import { createProjectManager } from '/ui/project-manager.js';
import { createSessionBar } from '/ui/session-bar.js';
import { createSkillsPanel } from '/ui/skills.js';
import { createSessionSurface } from '/ui/session-surface.js';
import { createStreamLog } from '/ui/stream-log.js';
import { createVoiceRecorder } from '/ui/voice.js';

const SESSION_LIMIT = 10;
const SESSION_NOTE = 'recent sessions unavailable';

const elements = queryElements();
let clientToken = loadToken();
const clientOptions = {
  baseUrl: globalThis.location.origin,
  ...(clientToken ? { token: clientToken } : {}),
};
const client = createClient(clientOptions);
// Read lazily everywhere it is used, so a token saved in Settings reaches the next request.
const connection = () => ({ baseUrl: globalThis.location.origin, token: clientToken });
let selectedStreamId = '';
const actionState = {
  opening: false,
  stopping: false,
  forking: false,
  interrupting: false,
};
let machineLoading = false;
let sessionsLoading = false;
let remoteSessions = [];
let machineSessions = [];
let registeredProjects = [];
let scopePresets = [];
let showAgents = loadShowAgentSessions();
const sessions = new Map();
const { transcript, sessionView } = createSessionSurface({
  connection,
  elements,
  // Ratified: "Steer now" escalates natively with escape; the separate stop control interrupts.
  onSteerNow: () => actions.sendKeys(sessions.get(selectedStreamId), ['escape']),
});
const streamLog = createStreamLog({
  transcript,
  selectedEntry: () => sessions.get(selectedStreamId),
  restartAction,
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
  onRename: (item, label) => void actions.renameSession(item, label),
  onToggleAgents: (next) => setShowAgents(next),
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
  onError: (message) => streamLog.error(message),
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
  onError: (message) => streamLog.error(message),
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
const composer = createComposer({ input: elements.composeInput, form: elements.composeForm });
const modelPicker = createModelPicker({
  select: elements.modelSelector,
  onChange: (model) => void actions.switchModel(model),
});
createVoiceRecorder({
  connection,
  button: elements.voiceRecord,
  cancelButton: elements.voiceCancel,
  input: elements.composeInput,
  note: setComposeNote,
  onError: (message) => streamLog.error(message),
  errorMessage,
});
const actions = createActions({
  client,
  elements,
  sessions,
  state: actionState,
  getSelectedStreamId: () => selectedStreamId,
  getActiveProject: () => projectManager.selectedProject(),
  getModel: () => modelPicker.selected(),
  connection,
  resetInput: () => composer.reset(),
  setStatus,
  refreshControls,
  renderSessions,
  renderStream: () => streamLog.render(),
  selectStream,
  ensureEntry,
  pushLine: streamLog.push,
  appendError: streamLog.error,
  errorMessage,
  notify: setComposeNote,
  reloadSessions: loadSessions,
});
const feed = createEventFeed({
  client,
  sessions,
  ensureEntry,
  streamLog,
  setStatus,
  onSessionEvent: (entry) => {
    streamLog.render();
    refreshControls();
    if (entry.stream_id === selectedStreamId) void gitStatus.update(entry);
  },
  isSelected: (streamId) => selectedStreamId === streamId,
  errorMessage,
});
const files = createFilesPanel({
  client,
  elements,
  errorMessage,
  onError: (message) => streamLog.error(message),
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
  onError: (message) => streamLog.error(message),
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
streamLog.render();
updateScope();
void boot();
wireConnectivity({
  setStatus,
  getSelected: () => selectedStreamId,
  hydrate: feed.hydrate,
  reconnect: () => client.reconnect(),
});
client.subscribe(0, feed.ingest, '*');

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
    streamLog.error(`machine session list failed: ${errorMessage(error)}`);
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

function setShowAgents(next) {
  showAgents = next;
  saveShowAgentSessions(next);
  setComposeNote(next ? 'showing agent-opened sessions' : 'showing your own sessions');
  renderSessions();
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
  streamLog.render();
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
  entry.sessionLabel = item.label || '';
  entry.origin = item.origin || '';
  entry.lastActivityAt = item.time || Date.now();
  return entry;
}

// Selecting a session never changes the project: the scope belongs to the owner, not to whatever
// they last tapped. Restarting is the one place the context moves, and the button says so first.
function selectStream(streamId) {
  const entry = sessions.get(streamId);
  if (!entry) return;
  selectedStreamId = streamId;
  elements.streamCaption.textContent = entry.sessionLabel || entry.label || streamId;
  streamLog.render();
  refreshControls();
  void gitStatus.update(entry);
  if (!streamId.startsWith('machine:')) void feed.hydrate(streamId);
  elements.composeInput.focus();
  sessionView.selectSession(sessionIdOf(entry));
}

function renderSessions() {
  sessionBar.update({
    items: sessionItems(),
    selectedId: selectedStreamId,
    presets: scopePresets,
    stopping: actionState.stopping,
    showAgents,
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
    showAgents,
  });
}

function restartAction(entry) {
  const restartable =
    entry.kind === 'session' &&
    (entry.status === 'done' || entry.status === 'failed' || entry.status === 'external');
  if (!restartable) return undefined;
  const target = entry.project || '';
  const current = projectManager.selectedProject()?.name ?? '';
  return {
    label: target && target !== current ? `Open new session in ${target}` : 'Open new session here',
    run: () => prepareRestart(entry),
  };
}

function prepareRestart(entry) {
  const target = entry.project || '';
  const current = projectManager.selectedProject()?.name ?? '';
  if (target && target !== current) {
    projectManager.selectProject(target);
    streamLog.showTransient('meta', `project switched to ${target} · you asked for this session`);
  }
  elements.composeInput.focus();
  elements.composeInput.scrollIntoView?.({ block: 'nearest' });
  streamLog.showTransient(
    'meta',
    `new session ready · ${entry.cwd || '(default cwd)'} · harness ${elements.harness.value}`,
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
