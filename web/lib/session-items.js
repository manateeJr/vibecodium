import { externalItem } from './external-session.js';

// Recent-session pills: the control plane's list for the scope, overlaid with live local state,
// plus the machine's own external sessions folded in by cwd so the bar shows every live session.
export function mergeSessionItems({
  remote,
  local,
  machine = [],
  projects = [],
  project,
  selectedId,
  limit,
}) {
  const items = new Map();
  for (const summary of remote) {
    if (!inScope(summary.project, project)) continue;
    items.set(summary.stream_id, {
      stream_id: summary.stream_id,
      session_id: summary.session_id ?? '',
      provider: summary.provider || 'session',
      status: summary.status || 'done',
      cwd: summary.cwd ?? '',
      project: summary.project ?? '',
      shortId: shortSessionId(summary.session_id || summary.stream_id),
      time: Date.parse(summary.updated_at ?? summary.started_at ?? '') || 0,
    });
  }
  for (const summary of machine) {
    const item = externalItem(summary, projects);
    if (!inScope(item.project, project)) continue;
    items.set(item.stream_id, item);
  }
  for (const entry of local) {
    if (entry.kind !== 'session') continue;
    if (!inScope(entry.project, project) && entry.stream_id !== selectedId) continue;
    items.set(entry.stream_id, {
      stream_id: entry.stream_id,
      session_id: entry.session_id ?? '',
      provider: entry.label || 'session',
      status: displayStatus(entry.status),
      cwd: entry.cwd ?? '',
      project: entry.project ?? '',
      shortId: shortSessionId(entry.session_id || entry.stream_id),
      time: activityTime(entry),
      ...(entry.external ? { external: true, title: entry.title ?? '' } : {}),
    });
  }
  return [...items.values()].sort((left, right) => right.time - left.time).slice(0, limit);
}

function inScope(name, project) {
  const value = String(name ?? '').trim();
  return project ? value === project.name : !value || value === 'Scratch';
}

function shortSessionId(value) {
  const id =
    String(value ?? '')
      .split(':')
      .pop() ?? '';
  if (!id) return 'session';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
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
