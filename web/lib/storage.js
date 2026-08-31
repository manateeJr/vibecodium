// Every durable browser preference goes through one pair of guarded accessors: private browsing
// can refuse localStorage outright, and the PWA must keep working when it does.
function read(key) {
  try {
    return globalThis.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

// Returns false when the browser refuses to persist, so the caller can say so.
function write(key, value) {
  try {
    if (value) globalThis.localStorage.setItem(key, value);
    else globalThis.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

const TOKEN_KEY = 'vibecodium.token';

export function loadToken() {
  return read(TOKEN_KEY).trim();
}

export function saveToken(value) {
  return write(TOKEN_KEY, value);
}

const HARNESS_KEY = 'vibecodium.default-harness';
const HARNESSES = new Set(['omp', 'codex', 'fake']);

export function loadDefaultHarness() {
  const value = read(HARNESS_KEY);
  return HARNESSES.has(value) ? value : 'fake';
}

export function saveDefaultHarness(value) {
  if (HARNESSES.has(value)) write(HARNESS_KEY, value);
}

// The project the OWNER last chose explicitly. Nothing else writes it: a session-derived switch
// that quietly overwrote this is exactly how the selector started preselecting a foreign project.
const PROJECT_KEY = 'vibecodium.project';

export function loadSelectedProject() {
  return read(PROJECT_KEY).trim();
}

export function saveSelectedProject(name) {
  write(PROJECT_KEY, name);
}

const MODEL_KEY = 'vibecodium.model';

export function loadSelectedModel() {
  return read(MODEL_KEY).trim();
}

export function saveSelectedModel(name) {
  write(MODEL_KEY, name);
}

const AGENT_SESSIONS_KEY = 'vibecodium.show-agent-sessions';

export function loadShowAgentSessions() {
  return read(AGENT_SESSIONS_KEY) === 'yes';
}

export function saveShowAgentSessions(visible) {
  write(AGENT_SESSIONS_KEY, visible ? 'yes' : '');
}
const SHOW_ALL_SESSIONS_KEY = 'vibecodium.show-all-sessions';

export function loadShowAllSessions() {
  return read(SHOW_ALL_SESSIONS_KEY) === 'yes';
}

export function saveShowAllSessions(visible) {
  write(SHOW_ALL_SESSIONS_KEY, visible ? 'yes' : '');
}

// The one-time safety cue shown before this phone first continues a machine-owned session (D3).
const EXTERNAL_HINT_KEY = 'vibecodium.external-hint-seen';

export function loadExternalHintSeen() {
  return read(EXTERNAL_HINT_KEY) === 'yes';
}

export function saveExternalHintSeen(seen) {
  write(EXTERNAL_HINT_KEY, seen ? 'yes' : '');
}

// Which reports this phone has already opened. Reports are server state and every phone reads them
// independently, so "read" is a local mark like every other value in here — the inbox badge counts
// the reports this device has not looked at, not the ones nobody has.
const SEEN_REPORTS_KEY = 'vibecodium.seen-reports';

export function loadSeenReports() {
  try {
    const value = JSON.parse(read(SEEN_REPORTS_KEY) || '[]');
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveSeenReports(ids) {
  write(SEEN_REPORTS_KEY, ids.length > 0 ? JSON.stringify(ids) : '');
}
