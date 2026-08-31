import assert from 'node:assert/strict';
import test from 'node:test';

// events.js is untyped browser JS the control plane serves verbatim from web/. It is outside
// tsconfig's emit, so a static import would resolve to dist/web/... at runtime and fail; the
// dynamic import below loads the real shipped file by URL relative to this compiled test. This is
// the same test-boundary loader phone-surface.test.ts uses for the rest of web/.
const webRoot = new URL('../../web/', import.meta.url);

type PushedLine = { readonly cls: string; readonly text: string };
type WorkState = {
  readonly lastUserSeq: number;
  readonly lastReplySeq: number;
  readonly working: boolean;
};
type FoldedEntry = { lines: PushedLine[]; work?: WorkState; busy?: boolean };
type EventEnvelopeLike = {
  readonly type: string;
  readonly seq: number;
  readonly ts: string;
  readonly stream_id: string;
  readonly payload: Record<string, unknown>;
};
type EventsModule = {
  readonly applySessionEvent: (
    entry: FoldedEntry,
    event: EventEnvelopeLike,
    pushLine: (entry: unknown, cls: string, text: string) => void,
  ) => void;
};

test('session_state events reconcile work state and render bookkeeping', async () => {
  const events = (await import(new URL('ui/events.js', webRoot).href)) as EventsModule;
  const entry: FoldedEntry = {
    lines: [],
    work: { lastUserSeq: 8, lastReplySeq: 2, working: true },
    busy: true,
  };
  const pushed: PushedLine[] = [];
  const base = { ts: '2026-08-31T08:00:00.000Z', stream_id: 'session:s1' };
  for (const [seq, state, reason] of [
    [3, 'resumable', 'reaped'],
    [4, 'resumable', 'reconciled'],
    [5, 'closed', 'shutdown'],
  ] as const) {
    events.applySessionEvent(
      entry,
      {
        ...base,
        type: 'session_state',
        seq,
        payload: { session_id: 's1', state, reason },
      },
      (_entry, cls, text) => pushed.push({ cls, text }),
    );
  }
  assert.equal(entry.busy, false, 'authoritative idle states clear the local busy flag');
  assert.equal(entry.work?.working, false, 'authoritative idle states clear folded work');
  assert.equal(pushed.length, 3, 'session_state events are no longer dropped');

  events.applySessionEvent(
    entry,
    { ...base, type: 'merge_to_main', seq: 6, payload: { branch: 'main', commit_sha: 'abc123' } },
    (_entry, cls, text) => pushed.push({ cls, text }),
  );
  assert.equal(pushed.length, 4, 'a non-session_state event still renders');
});
