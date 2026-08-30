import { projectForPath } from './paths.js';
import { relativeTime } from './time.js';

// External harness sessions live on the machine. Vibecodium shows them, it never drives them:
// selecting one opens a read-only view, and resuming still goes through the fork flow.
export function externalItem(summary, projects) {
  return {
    stream_id: `machine:${summary.source}:${summary.ref}`,
    session_id: summary.ref ?? '',
    provider: summary.source || 'machine',
    status: 'live',
    cwd: summary.cwd ?? '',
    project: projectForPath(summary.cwd, projects),
    shortId: shortRef(summary.ref),
    title: summary.title ?? '',
    updated_at: summary.updated_at ?? '',
    external: true,
    time: Date.parse(summary.updated_at ?? '') || 0,
  };
}

export function externalEntry(item) {
  return {
    stream_id: item.stream_id,
    kind: 'session',
    label: item.provider,
    status: 'external',
    external: true,
    title: item.title ?? '',
    busy: false,
    lines: externalTranscript(item),
    cwd: item.cwd || '',
    project: item.project || '',
    updated_at: item.updated_at ?? '',
    lastActivityAt: item.time || Date.now(),
  };
}

function externalTranscript(item) {
  return [
    metaLine(`external ${item.provider} session · read-only`),
    { cls: 'you', text: item.title || item.shortId, markdown: false },
    metaLine(`cwd ${item.cwd || '(unknown)'} · ${relativeTime(item.updated_at)}`),
    metaLine('this machine owns the session · HISTORY → MACHINE SESSIONS resumes it as a fork'),
  ];
}

function metaLine(text) {
  return { cls: 'meta', text, markdown: false };
}

function shortRef(value) {
  const ref =
    String(value ?? '')
      .split(':')
      .pop() ?? '';
  if (!ref) return 'session';
  return ref.length > 8 ? `${ref.slice(0, 8)}…` : ref;
}
