const TOKEN_KEY = 'vibecodium.token';

export function loadToken() {
  try {
    return (globalThis.localStorage.getItem(TOKEN_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

// Returns false when the browser refuses to persist, so the caller can say so.
export function saveToken(value) {
  try {
    if (value) globalThis.localStorage.setItem(TOKEN_KEY, value);
    else globalThis.localStorage.removeItem(TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}

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
