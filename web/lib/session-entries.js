// The shapes a session takes on this page. app.js decides WHICH session is selected and what is
// rendered; the record it selects — created by event replay, adopted from a list, or picked off the
// cold-start home — is built here, once, so the three paths cannot drift apart.

// A session the event feed just saw for the first time. It is live by definition: an event arrived.
export function blankEntry(streamId, kind, label) {
  return {
    stream_id: streamId,
    kind,
    label: label || 'session',
    status: 'running',
    busy: false,
    lines: [],
    cwd: '',
    project: '',
    lastActivityAt: Date.now(),
  };
}

// Durable metadata from a list entry laid over whatever the local overlay already knows.
export function applyItem(entry, item) {
  if (item.session_id) entry.session_id = item.session_id;
  entry.status = item.status === 'live' ? 'running' : item.status === 'failed' ? 'failed' : 'done';
  entry.cwd = item.cwd || '';
  entry.project = item.project || '';
  entry.sessionLabel = item.label || '';
  entry.origin = item.origin || '';
  if (item.source !== undefined) entry.source = item.source;
  if (item.pinned !== undefined) entry.pinned = item.pinned;
  entry.provider = item.provider || entry.provider || '';
  entry.abort_key = item.abort_key || entry.abort_key || '';
  entry.lastActivityAt = item.time || Date.now();
  return entry;
}

export function itemFromRecent(session) {
  return {
    stream_id: `session:${session.session_id}`,
    session_id: session.session_id,
    provider: session.provider,
    abort_key: session.abort_key || '',
    status: session.state,
    cwd: session.cwd,
    project: session.project || '',
    label: session.label,
    origin: session.origin,
    source: session.source ?? null,
    pinned: session.pinned === true,
    time: Date.parse(session.updated_at) || Date.now(),
  };
}
// Event replay can create a local entry before session.list resolves. Keep the local overlay's
// durable metadata in sync, or it hides labels and origins from the server summary after a reload.
export function overlayRemote(entries, summaries) {
  for (const summary of summaries) {
    const entry = entries.get(summary.stream_id);
    if (!entry) continue;
    entry.provider = summary.provider || entry.provider || '';
    entry.abort_key = summary.abort_key || entry.abort_key || '';
    entry.sessionLabel = summary.label || '';
    entry.origin = summary.origin || '';
    if (summary.source !== undefined) entry.source = summary.source;
    if (summary.pinned !== undefined) entry.pinned = summary.pinned;
  }
}
