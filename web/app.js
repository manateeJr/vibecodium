import { createClient } from '/client.js';
import { externalEntry, externalItem } from '/lib/external-session.js';
import { applyItem, blankEntry, itemFromRecent, overlayRemote } from '/lib/session-entries.js';
import { mergeSessionItems, sessionIdOf } from '/lib/session-items.js';
import {
  loadExternalHintSeen,
  loadShowAgentSessions,
  loadShowAllSessions,
  loadToken,
  saveExternalHintSeen,
  saveShowAgentSessions,
  saveShowAllSessions,
  saveToken,
} from '/lib/storage.js';
import { createActions } from '/ui/actions.js';
import { renderComposeControls } from '/ui/compose-controls.js';
import { createComposer } from '/ui/composer.js';
import { wireConnectivity } from '/ui/connectivity.js';
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
  resuming: false,
  interrupting: false,
};
let machineLoading = false;
let sessionsLoading = false;
let recentLoading = false;
let remoteSessions = [];
let recentSessions = [];
let machineSessions = [];
let registeredProjects = [];
let showAgents = loadShowAgentSessions();
let showAllSessions = loadShowAllSessions();
const sessions = new Map();
const { transcript, sessionView, home, chip } = createSessionSurface({
  connection,
  elements,
  // Steer now escalates natively with escape; the separate STOP control uses the selected
  // harness's declared turn-abort key.
  onSteerNow: () => actions.sendKeys(sessions.get(selectedStreamId), ['escape']),
  onRename: (entry, label) => void actions.renameSession(entry, label),
  onStop: () => void actions.stopSession(),
  onPin: (entry, pinned) => void pinSession(entry, pinned),
  onSelectRecent: (session) => selectRecent(session),
  onError: (message) => streamLog.error(message),
  errorMessage,
  getShowAllSessions: () => showAllSessions,
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
  getShowAllSessions: () => showAllSessions,
  onLiveSelect: (item) => {
    selectSessionItem(item);
    history.close();
  },
  onRecentSelect: (item) => {
    selectRecent(item);
    history.close();
  },
  onPin: (item, pinned) => void pinSession(item, pinned),
  onMachineSelect: (summary) => {
    selectSessionItem(externalItem(summary, registeredProjects));
    history.close();
  },
  onNew: () => selectNew(),
  onPreset: (preset) => selectPreset(preset),
  onOpen: () => Promise.all([loadMachineSessions(), loadRecentSessions()]),
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
  onToggleShowAllSessions: (next) => setShowAllSessions(next),
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
  // Only reached once a send actually landed, which is also when the one-time hint has done its
  // job: it clears itself there rather than waiting to be dismissed by hand.
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
// The header's project name is the affordance the composer placeholder points at: tapping it opens
// HISTORY on the project picker, which is where the scope selectors now live.
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
settings.setShowAllSessions(showAllSessions);
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

// Projects come first: external sessions, adopted skills and a share's project guess are all
// keyed off the project list.
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
async function loadRecentSessions() {
  if (recentLoading) return;
  recentLoading = true;
  const project = projectManager.selectedProject();
  try {
    const args = { limit: SESSION_LIMIT, include_ended: true };
    if (project?.name) args.project = project.name;
    const result = await client.sessionRecent(args);
    recentSessions = [...result.sessions];
    history.renderRecent(recentSessions);
  } catch (error) {
    recentSessions = [];
    history.renderRecent([]);
    streamLog.error(`${SESSION_NOTE}: ${errorMessage(error)}`);
  } finally {
    recentLoading = false;
  }
}

function updateScope() {
  const project = projectManager.selectedProject();
  // D7: the project name stays visible in the main header line; its path is detail, so it rides
  // the picker inside the `+ NEW` flow rather than the message column.
  elements.activeProject.textContent = project?.name || 'Scratch';
  elements.scopePath.textContent = project?.path || '(default cwd)';
  refreshPresets();
  skills.render();
  refreshControls();
  void loadSessions();
  void loadMachineSessions();
  void loadRecentSessions();
}

// Presets are the project's adopted skills first, then its detected quick actions. They are the
// curated first message for the session `+ NEW` is about to start, so they live in that flow.
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
function setShowAllSessions(next) {
  showAllSessions = next;
  saveShowAllSessions(next);
  renderSessions();
  history.renderRecent(recentSessions);
  history.renderMachine(machineSessions);
  void home.refresh();
}

async function pinSession(item, pinned) {
  const session_id = item?.session_id || sessionIdOf(item);
  if (!session_id) {
    streamLog.error('this session cannot be pinned');
    return;
  }
  try {
    await client.sessionPin({ session_id, pinned });
    item.pinned = pinned;
    const entry = sessions.get(item.stream_id || `session:${session_id}`);
    if (entry) entry.pinned = pinned;
    void loadRecentSessions();
    void loadSessions();
  } catch (error) {
    streamLog.error(`session pin failed: ${errorMessage(error)}`);
  }
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

// No active session: the main column shows the cold-start home — the operator's last sessions with
// three lines of transcript each — over the composer, instead of an empty transcript.
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

// External sessions are read-only here: the machine owns them until the operator writes into them.
// Read-only is not the same as blank, though — the transcript the machine already wrote is fetched
// once, so the operator can see what they are about to continue.
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

// Selecting a session never changes the project: the scope belongs to the owner, not to whatever
// they last tapped. Restarting is the one place the context moves, and the button says so first.
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
