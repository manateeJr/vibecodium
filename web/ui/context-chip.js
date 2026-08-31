// How much of the model's context window the selected session has already spent. Everything about
// that reading lives here — the validity rule, the wording, and the render — because the number
// arrives in two halves from two places: the harness transcript carries the token count, the model
// catalogue carries the window. Either half missing means there is no percentage to state, and the
// one thing this chip must never do is show a confident `ctx[0%/...]` while the window is still
// unresolved: that reads as "plenty of room left" at exactly the moment the truth matters.

// The event payload is untrusted. A count the harness could not resolve has to land on the entry as
// `undefined` and not as a zero, so the sanitising happens once, at the fold, in the same shape the
// renderer below re-checks for entries that never saw an event at all.
export function contextUsage(payload) {
  const value = payload && typeof payload === 'object' ? payload : {};
  return { tokens: tokenCount(value.tokens), window: tokenCount(value.context_window) };
}

// The whole reading, or nothing. `ctx[34%/272k]` — percentage spent, then the window it is spent
// out of, because a bare percentage says nothing about whether 34% is a lot of room or a little.
export function formatContextChip(context) {
  const tokens = tokenCount(context?.tokens);
  // Never named `window`: this is browser code and shadowing that global reads as a mistake.
  const limit = tokenCount(context?.window);
  if (tokens === undefined || limit === undefined) return null;
  return `ctx[${Math.round((tokens / limit) * 100)}%/${Math.round(limit / 1000)}k]`;
}

export function renderContextChip({ element, entry }) {
  if (!element) return;
  const text = formatContextChip(entry?.context);
  // Cleared as well as hidden: a stale reading left in the node would be read out by a screen
  // reader and would flash on the next unhide before the fresh number replaces it.
  element.hidden = text === null;
  element.textContent = text ?? '';
}

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
