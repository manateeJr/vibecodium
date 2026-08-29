const RECENT_PROJECTS_KEY = 'vibecodium.recent-projects';
const HARNESS_KEY = 'vibecodium.default-harness';
const HARNESSES = new Set(['omp', 'codex', 'fake']);

export function loadRecentProjects() {
  try {
    const parsed = JSON.parse(globalThis.localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === 'string' && value.trim()).slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentProject(path) {
  const value = path.trim();
  if (!value) return loadRecentProjects();
  const recent = [value, ...loadRecentProjects().filter((item) => item !== value)].slice(0, 8);
  try {
    globalThis.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recent));
  } catch {
    return recent;
  }
  return recent;
}

export function loadDefaultHarness() {
  try {
    const value = globalThis.localStorage.getItem(HARNESS_KEY);
    return HARNESSES.has(value) ? value : 'fake';
  } catch {
    return 'fake';
  }
}

export function saveDefaultHarness(value) {
  if (!HARNESSES.has(value)) return;
  try {
    globalThis.localStorage.setItem(HARNESS_KEY, value);
  } catch {
    // Storage can be disabled in private browsing; the live selection still applies.
  }
}
