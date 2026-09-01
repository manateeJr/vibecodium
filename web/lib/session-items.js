// Every session HISTORY can list: the control plane's own list, overlaid with the live local state
// the event feed maintains. The project scope and the agent filter that used to live here belonged
// to the deleted session bar — the drawer owns both now, with its own project filter and the
// Settings toggle — so this is a plain merge, newest first.
export function mergeSessionItems({ remote, local, limit }) {
  const items = new Map();
  for (const summary of remote) {
    items.set(summary.stream_id, {
      stream_id: summary.stream_id,
      session_id: summary.session_id ?? '',
      provider: summary.provider || 'session',
      status: summary.status || 'done',
      cwd: summary.cwd ?? '',
      project: summary.project ?? '',
      label: summary.label ?? '',
      origin: summary.origin ?? '',
      ...(summary.source === undefined ? {} : { source: summary.source }),
      ...(summary.pinned === undefined ? {} : { pinned: summary.pinned }),
      ...(summary.archived === undefined ? {} : { archived: summary.archived }),
      time: Date.parse(summary.updated_at ?? summary.started_at ?? '') || 0,
    });
  }
  for (const entry of local) {
    if (entry.kind !== 'session') continue;
    items.set(entry.stream_id, {
      stream_id: entry.stream_id,
      session_id: entry.session_id ?? '',
      provider: entry.label || 'session',
      status: displayStatus(entry.status),
      cwd: entry.cwd ?? '',
      project: entry.project ?? '',
      label: entry.sessionLabel ?? '',
      ...(entry.source === undefined ? {} : { source: entry.source }),
      ...(entry.pinned === undefined ? {} : { pinned: entry.pinned }),
      ...(entry.archived === undefined ? {} : { archived: entry.archived }),
      time: activityTime(entry),
      ...(entry.external ? { external: true, title: entry.title ?? '' } : {}),
    });
  }
  return [...items.values()].sort((left, right) => right.time - left.time).slice(0, limit);
}

// The id a live session is addressed by. Machine-owned streams are read-only here and have no
// addressable session, so they resolve to '' and every caller degrades the same way.
export function sessionIdOf(entry) {
  if (!entry || entry.kind !== 'session' || entry.stream_id.startsWith('machine:')) return '';
  return entry.session_id || entry.stream_id.slice('session:'.length);
}

function activityTime(entry) {
  if (Number.isFinite(entry.lastActivityAt)) return entry.lastActivityAt;
  const updatedAt = Date.parse(entry.updated_at ?? '');
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function displayStatus(status) {
  if (status === 'running' || status === 'external') return 'live';
  if (status === 'failed' || status === 'throttled') return 'failed';
  return 'done';
}
