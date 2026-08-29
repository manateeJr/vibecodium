const HARNESS_KEY = 'vibecodium.default-harness';
const HARNESSES = new Set(['omp', 'codex', 'fake']);

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
