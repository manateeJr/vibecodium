import assert from 'node:assert/strict';
import test from 'node:test';

// events.js is untyped browser JS the control plane serves verbatim from web/. It is outside
// tsconfig's emit, so a static import would resolve to dist/web/... at runtime and fail; the
// dynamic import below loads the real shipped file by URL relative to this compiled test. This is
// the same test-boundary loader phone-surface.test.ts uses for the rest of web/.
const webRoot = new URL('../../web/', import.meta.url);

type PushedLine = { readonly cls: string; readonly text: string };
type EventEnvelopeLike = {
  readonly type: string;
  readonly seq: number;
  readonly ts: string;
  readonly stream_id: string;
  readonly payload: Record<string, unknown>;
};
type EventsModule = {
  readonly applySessionEvent: (
    entry: { lines: PushedLine[] },
    event: EventEnvelopeLike,
    pushLine: (entry: unknown, cls: string, text: string) => void,
  ) => void;
};

test('session_state events are folded but never rendered as transcript lines', async () => {
  const events = (await import(new URL('ui/events.js', webRoot).href)) as EventsModule;
  const entry = { lines: [] as PushedLine[] };
  const pushed: PushedLine[] = [];
  const base = { ts: '2026-08-31T08:00:00.000Z', stream_id: 'session:s1' };
  // The idle reaper's reconcile/reap sweeps fire on a timer; each one used to land as a turn and
  // bury the conversation under {"state":"resumable","reason":"reconciled"} noise (#screenshot).
  for (const reason of ['reaped', 'reconciled', 'reconciled', 'resumed'] as const) {
    events.applySessionEvent(
      entry,
      {
        ...base,
        type: 'session_state',
        seq: 1,
        payload: { session_id: 's1', state: 'resumable', reason },
      },
      (_entry, cls, text) => pushed.push({ cls, text }),
    );
  }
  assert.equal(pushed.length, 0, 'no session_state event may push a transcript line');

  // A real event still renders through the same catch-all path, proving the filter is targeted and
  // not swallowing conversation or other meta lines.
  events.applySessionEvent(
    entry,
    { ...base, type: 'merge_to_main', seq: 2, payload: { branch: 'main', commit_sha: 'abc123' } },
    (_entry, cls, text) => pushed.push({ cls, text }),
  );
  assert.equal(pushed.length, 1, 'a non-session_state event still renders');
});
