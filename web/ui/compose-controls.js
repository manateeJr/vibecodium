import { isExternalEntry } from '../lib/external-session.js';
import { sessionIdOf } from '../lib/session-items.js';

// What the compose bar promises before the operator commits. The same input carries three verbs —
// send into a live session, continue a machine-owned session in place, or open a new one — and the
// middle one is the one that has to be said out loud: this tap used to open a brand new session,
// and it now appends to the machine's own transcript instead. The hint states that, once.
export function renderComposeControls({ elements, entry, state }) {
  const sendable =
    entry?.kind === 'session' && (entry.status === 'running' || entry.status === 'ready');
  const external = isExternalEntry(entry);
  elements.composeSend.textContent = sendable || external ? 'SEND' : 'OPEN';
  elements.composeSend.classList.toggle('button--send', sendable);
  elements.composeSend.classList.toggle('button--continue', external);
  elements.composeSend.classList.toggle('button--open', !sendable && !external);
  elements.composeSend.disabled =
    state.opening || state.resuming || Boolean(sendable && entry?.busy);
  elements.composeInput.placeholder = composePlaceholder(entry, sendable, external);
  elements.composeHint.textContent = external
    ? `continues this ${entry.label} session on the machine · nothing is written until you send`
    : '';
  elements.composeHint.hidden = !external;
  elements.interruptKey.disabled =
    state.opening || state.interrupting || !sendable || !sessionIdOf(entry);
}

function composePlaceholder(entry, sendable, external) {
  if (sendable) return 'Write something…';
  if (external) return 'Continue this machine session…';
  if (entry) return 'Continue in a new session…';
  return 'Describe a task to start a session…';
}
