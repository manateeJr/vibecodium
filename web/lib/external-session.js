import { projectForPath } from './paths.js';
import { relativeTime } from './time.js';

// External harness sessions live on the machine. Vibecodium shows them, it never forks them:
// selecting one opens a read-only view, and the operator's first send continues that very session
// in place — `session.resume` reopens the machine's own transcript and appends to it.
//
// `kind` separates a machine's own top-level sessions from the subagent transcripts they spawn.
// The history drawer still lists every one of them; only the session bar drops the subagents.
export function externalItem(summary, projects) {
  return {
    stream_id: `machine:${summary.source}:${summary.ref}`,
    session_id: summary.ref ?? '',
    provider: summary.source || 'machine',
    status: 'live',
    cwd: summary.cwd ?? '',
    project: projectForPath(summary.cwd, projects),
    shortId: shortRef(summary.ref),
    kind: summary.kind === 'subagent' ? 'subagent' : 'main',
    title: summary.title ?? '',
    updated_at: summary.updated_at ?? '',
    external: true,
    time: Date.parse(summary.updated_at ?? '') || 0,
  };
}

// The `ref` is what `session.resume` needs to reopen the machine's transcript, so the read-only
// entry carries it: the operator's first send has to reach the original session, not a copy.
export function externalEntry(item) {
  return {
    stream_id: item.stream_id,
    kind: 'session',
    label: item.provider,
    status: 'external',
    external: true,
    ref: item.session_id || '',
    title: item.title ?? '',
    busy: false,
    lines: externalTranscript(item),
    cwd: item.cwd || '',
    project: item.project || '',
    updated_at: item.updated_at ?? '',
    lastActivityAt: item.time || Date.now(),
  };
}

// True only while the entry is still the machine's to drive. Continuing it turns the entry into an
// ordinary live session, so this predicate is also what tells the composer which verb it holds.
export function isExternalEntry(entry) {
  return Boolean(entry?.external) && entry.status === 'external';
}

function externalTranscript(item) {
  return [
    metaLine(`external ${item.provider} session · read-only`),
    { cls: 'you', text: item.title || item.shortId, markdown: false },
    metaLine(`cwd ${item.cwd || '(unknown)'} · ${relativeTime(item.updated_at)}`),
    metaLine('this machine owns the session · your next message continues it here, in place'),
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
