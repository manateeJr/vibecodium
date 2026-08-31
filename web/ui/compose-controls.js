import { isExternalEntry } from '../lib/external-session.js';
import { sessionIdOf } from '../lib/session-items.js';

// What the compose bar promises before the operator commits. One verb — SEND — because a button
// that renamed itself between OPEN and SEND read as two different buttons on a phone while saying
// less about what would happen than the placeholder already says. The placeholder carries the mode:
// which session this lands in, or which project a new one would start in.
export function renderComposeControls({ elements, entry, state, project, hint }) {
  const sendable =
    entry?.kind === 'session' && (entry.status === 'running' || entry.status === 'ready');
  const external = isExternalEntry(entry);
  elements.composeSend.textContent = 'SEND';
  // Amber for a send that lands on the machine's own session, the same warning colour as the hint.
  elements.composeSend.classList.toggle('button--continue', external);
  elements.composeSend.classList.toggle('button--send', !external);
  elements.composeSend.disabled =
    state.opening || state.resuming || Boolean(sendable && entry?.busy);
  elements.composeInput.placeholder = composePlaceholder(sendable, external, project);
  hint.update(
    external
      ? `this continues the ${entry.label} session on the machine · nothing is written until you send`
      : '',
  );
  elements.interruptKey.disabled =
    state.opening || state.interrupting || !sendable || !sessionIdOf(entry) || !entry?.abort_key;
}
function composePlaceholder(sendable, external, project) {
  if (sendable) return 'Write something…';
  if (external) return 'Continue this machine session…';
  return `New session in ${project || 'Scratch'}…`;
}
