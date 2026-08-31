import { eventClock } from '../lib/time.js';

// Everything the transcript panel shows for the selected session: the session's own lines plus
// the transient lines that belong to no session (throttling, project switches, errors raised
// before a session exists). Transient lines expire on their own so they never look like history.
const TRANSIENT_MS = 6_000;

export function createStreamLog({ transcript, selectedEntry, restartAction }) {
  const transient = [];
  let timer = null;

  const render = () => {
    const entry = selectedEntry();
    transcript.render(
      entry ? [...transient, ...entry.lines] : transient,
      Boolean(entry?.busy),
      entry ? restartAction(entry) : undefined,
    );
  };

  const showTransient = (cls, text) => {
    transient.push({ cls, text, markdown: false });
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(() => {
      transient.length = 0;
      timer = null;
      render();
    }, TRANSIENT_MS);
    render();
  };

  const push = (entry, cls, text, markdown = false, metadata) => {
    entry.lastActivityAt = Date.now();
    const line = { cls, text, markdown, ...(metadata ?? {}) };
    entry.lines.push(line);
    if (entry === selectedEntry()) render();
    return line;
  };

  const error = (message, entry = selectedEntry()) => {
    const text = `${eventClock(new Date().toISOString())} error · ${message}`;
    if (entry) push(entry, 'bad', text);
    else showTransient('bad', text);
  };

  return { render, push, showTransient, error };
}
