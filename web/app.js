import { createClient } from '/client.js';
import { errorMessage } from '/lib/command.js';
import { externalEntry, externalItem } from '/lib/external-session.js';
import { applyItem, blankEntry, itemFromRecent, overlayRemote } from '/lib/session-entries.js';
import { createHistoryController } from '/lib/history-controller.js';
import { mergeSessionItems, sessionIdOf } from '/lib/session-items.js';
import {
  loadExternalHintSeen,
  loadShowAgentSessions,
  loadToken,
  saveExternalHintSeen,
  saveShowAgentSessions,
  saveToken,
} from '/lib/storage.js';
import { createActions } from '/ui/actions.js';
import { renderComposeControls } from '/ui/compose-controls.js';
import { createComposer } from '/ui/composer.js';
import { createConnectionMonitor, wireConnectivity } from '/ui/connectivity.js';
import { createHistoryDrawer, createSettingsDrawer } from '/ui/drawers.js';
import { createExternalHint } from '/ui/external-hint.js';
import { queryElements } from '/ui/elements.js';
import { createEventFeed } from '/ui/event-feed.js';
import { createFilesPanel } from '/ui/files.js';
import { createGitStatus } from '/ui/git-status.js';
import { createHostPanel } from '/ui/host-panel.js';
import { createModelPicker } from '/ui/model-picker.js';
import { createMachineHistory } from '/ui/machine-history.js';
import { createProjectManager } from '/ui/project-manager.js';
import { createRestartAction } from '/ui/restart-action.js';
import { createShareIntake } from '/ui/share-intake.js';
import { createSkillsPanel } from '/ui/skills.js';
import { createSessionSurface } from '/ui/session-surface.js';
import { createStreamLog } from '/ui/stream-log.js';
import { wireServiceWorkerUpdates } from '/ui/updates.js';
import { createVoiceRecorder } from '/ui/voice.js';
const SESSION_LIMIT = 10;
const SESSION_NOTE = 'recent sessions unavailable';
const elements = queryElements();
let clientToken = loadToken();
const clientOptions = { baseUrl: globalThis.location.origin };
if (clientToken) clientOptions.token = clientToken;
clientOptions.webSocket = createConnectionMonitor(
  setStatus,
  () => selectedStreamId,
  () => actions.flushQueuedSends(),
);
const client = createClient(clientOptions);
const connection = () => ({ baseUrl: globalThis.location.origin, token: clientToken });
let selectedStreamId = '';
const actionState = {
  opening: false,
  stopping: false,
  resuming: false,
  interrupting: false,
};
let machineLoading = false;
let sessionsLoading = false;
let remoteSessions = [];
let machineSessions = [];
let registeredProjects = [];
let showAgents = loadShowAgentSessions();
let historyController;
const sessions = new Map();
const { transcript, sessionView, home, chip } = createSessionSurface({
  connection,
  elements,
  onSteerNow: () => actions.sendKeys(sessions.get(selectedStreamId), ['escape']),
  onRename: (entry, label) => void actions.renameSession(entry, label),
  onStop: () => void actions.stopSession(),
  onPin: (entry, pinned) => void historyController?.pinSession(entry, pinned),
  onSelectRecent: (session) => selectRecent(session),
  onError: (message) => streamLog.error(message),
  errorMessage,
  getShowAllSessions: () => historyController?.showAllSessions ?? false,
});
const restartAction = createRestartAction({
  elements,
  getProject: () => projectManager.selectedProject()?.name ?? '',
  selectProject: (name) => projectManager.selectProject(name),
  showTransient: (cls, text) => streamLog.showTransient(cls, text),
});
const streamLog = createStreamLog({
  transcript,
  selectedEntry: () => sessions.get(selectedStreamId),
  restartAction,
});
const gitStatus = createGitStatus({
  client,
  target: elements.gitStatus,
});
const history = createHistoryDrawer({
  drawer: elements.historyDrawer,
  toggle: elements.historyToggle,
  closeButton: elements.historyClose,
  scrollContainer: elements.historyScroll,
  searchInput: elements.historySearch,
  projectFilter: elements.historyProjectFilter,
  pinnedList: elements.pinnedHistory,
  liveList: elements.liveHistory,
  endedList: elements.endedHistory,
  machineList: elements.machineHistory,
  newButton: elements.newSession,
  newFlow: elements.newSessionFlow,
  newStart: elements.newSessionStart,
  presetRow: elements.sessionPresets,
  getShowAgents: () => showAgents,
  getShowAllSessions: () => historyController?.showAllSessions ?? false,
  onLiveSelect: (item) => {
    selectSessionItem(item);
    history.close();
  },
  onRecentSelect: (item) => {
    selectRecent(item);
    history.close();
  },
  onPin: (item, pinned) => void historyController?.pinSession(item, pinned),
  onMachineSelect: (summary) => {
    selectSessionItem(externalItem(summary, registeredProjects));
    history.close();
  },
  onNew: () => selectNew(),
  onPreset: (preset) => selectPreset(preset),
  onOpen: () => Promise.all([loadMachineSessions(), historyController?.loadRecentSessions()]),
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
  onProjectChange: (project) => {
    history.setSelectedProject(project?.name ?? '');
    updateScope();
  },
});
historyController = createHistoryController({
  client,
  history,
  home,
  projectManager,
  sessions,
  streamLog,
  sessionIdOf,
  errorMessage,
  renderSessions,
  loadSessions,
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
  showAgents: elements.showAgents,
  showAllSessions: elements.showAllSessions,
  onToggleAgents: (next) => setShowAgents(next),
  onToggleShowAllSessions: (next) => historyController.setShowAllSessions(next),
  onTokenInput: (value) => commitToken(value),
  onTokenCommit: (value) => commitToken(value),
  onOpen: () => {
    void hostPanel.refresh();
    void skills.refresh();
  },
});
const composer = createComposer({ input: elements.composeInput, form: elements.composeForm });
const externalHint = createExternalHint({
  hint: elements.externalHint,
  text: elements.externalHintText,
  dismiss: elements.externalHintDismiss,
  loadSeen: loadExternalHintSeen,
  saveSeen: saveExternalHintSeen,
});
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
  resetInput: () => {
    composer.reset();
    externalHint.dismissAfterSend();
  },
  getPrompt: () => composer.getPrompt(),
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
  onSessionEvent: (entry, event) => {
    if (event.type === 'turn_complete' && entry.stream_id === selectedStreamId) {
      actionState.interrupting = false;
    }
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
  attachPaths: (paths) => composer.stageAttachments(paths),
  onOpen: () => {
    history.close();
    settings.close();
  },
});
const machineHistory = createMachineHistory({
  connection,
  getEntry: (streamId) => sessions.get(streamId),
  render: () => streamLog.render(),
  errorMessage,
});
const shareIntake = createShareIntake({
  connection,
  elements,
  projectManager,
  attachPaths: (paths) => files.attachPaths(paths),
  stageNote: (note) => composer.stageNote(note),
  onError: (message) => streamLog.error(message),
  errorMessage,
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
  const entry = sessions.get(selectedStreamId);
  if (!entry?.abort_key) return;
  void actions.sendKeys(entry, [entry.abort_key], 'interrupting');
});
elements.activeProject.addEventListener('click', () => {
  settings.close();
  files.close();
  history.openNewFlow();
});
setStatus(
  globalThis.navigator.onLine ? 'READY' : 'OFFLINE',
  globalThis.navigator.onLine ? 'idle' : 'bad',
);
settings.setShowAgents(showAgents);
settings.setShowAllSessions(historyController.showAllSessions);
showHome();
updateScope();
void boot();
wireConnectivity({
  setStatus,
  getSelected: () => selectedStreamId,
  hydrate: feed.hydrate,
  reconnect: () => client.reconnect(),
});
wireServiceWorkerUpdates({ button: elements.updateReload });
client.subscribe(0, feed.ingest, '*');
async function boot() {
  await projectManager.load();
  refreshPresets();
  await Promise.all([skills.refresh(), loadMachineSessions(), shareIntake.run()]);
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
    overlayRemote(sessions, remoteSessions);
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
  elements.activeProject.textContent = project?.name || 'Scratch';
  elements.scopePath.textContent = project?.path || '(default cwd)';
  refreshPresets();
  skills.render();
  refreshControls();
  void loadSessions();
  void loadMachineSessions();
  void historyController.loadRecentSessions();
}

function refreshPresets() {
  const project = projectManager.selectedProject();
  history.setPresets([
    ...skills.presets(),
    ...(project?.quickActions ?? []).map((action) => ({
      kind: 'action',
      id: action.id,
      label: action.label,
      prompt: action.prompt,
      title: action.prompt,
    })),
  ]);
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
  renderComposeControls({
    elements,
    entry: sessions.get(selectedStreamId),
    state: actionState,
    project: projectManager.selectedProject()?.name ?? '',
    hint: externalHint,
  });
  renderSessions();
}

function ensureEntry(streamId, label = '') {
  const kind = streamId.split(':', 1)[0];
  if (kind !== 'session') return null;
  const entry = sessions.get(streamId);
  if (!entry) sessions.set(streamId, blankEntry(streamId, kind, label));
  else if (label) entry.label = label;
  return sessions.get(streamId);
}

function showHome() {
  selectedStreamId = '';
  gitStatus.hide();
  sessionView.setHome(true);
  sessionView.selectSession('');
  void home.refresh();
  streamLog.render();
  refreshControls();
}

function selectNew() {
  showHome();
  elements.composeInput.focus();
}

function selectRecent(session) {
  selectSessionItem(itemFromRecent(session));
}

function selectSessionItem(item) {
  const existing = sessions.get(item.stream_id);
  const entry = existing ?? (item.external ? adoptExternalItem(item) : adoptSessionItem(item));
  if (!entry) return;
  selectStream(entry.stream_id);
}

function adoptExternalItem(item) {
  const entry = externalEntry(item);
  sessions.set(entry.stream_id, entry);
  void machineHistory.load(entry);
  return entry;
}

function adoptSessionItem(item) {
  const entry = ensureEntry(item.stream_id, item.provider);
  return entry ? applyItem(entry, item) : null;
}

function selectStream(streamId) {
  const entry = sessions.get(streamId);
  if (!entry) return;
  selectedStreamId = streamId;
  sessionView.setHome(false);
  streamLog.render();
  refreshControls();
  void gitStatus.update(entry);
  if (!streamId.startsWith('machine:')) void feed.hydrate(streamId);
  elements.composeInput.focus();
  sessionView.selectSession(sessionIdOf(entry));
}

function renderSessions() {
  history.renderLive(sessionItems());
  chip.update({ entry: sessions.get(selectedStreamId), stopping: actionState.stopping });
}

function sessionItems() {
  return mergeSessionItems({
    remote: remoteSessions,
    local: [...sessions.values()],
    limit: SESSION_LIMIT,
  });
}
