import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// context-chip.js and events.js are untyped browser modules the control plane serves verbatim from
// web/. They are outside tsconfig's emit, so a static import would resolve to dist/web/... at
// runtime and fail; the dynamic imports below load the real shipped files by URL relative to this
// compiled test, the same test-boundary loader transcript-events.test.ts uses.
const webRoot = new URL('../../web/', import.meta.url);
const chipModule = new URL('ui/context-chip.js', webRoot).href;

// `| undefined` throughout, not bare optionals: the repo compiles with exactOptionalPropertyTypes,
// and an absent window is a value this module is required to carry, not a property it omits.
type ContextUsage = { readonly tokens?: number | undefined; readonly window?: number | undefined };
type ChipElement = { hidden: boolean; textContent: string };
type ChipModule = {
  readonly formatContextChip: (context: ContextUsage | undefined) => string | null;
  readonly renderContextChip: (input: {
    readonly element: ChipElement;
    readonly entry?: { readonly context?: ContextUsage | undefined } | undefined;
  }) => void;
};
type EventEnvelopeLike = {
  readonly type: string;
  readonly seq: number;
  readonly ts: string;
  readonly stream_id: string;
  readonly payload: Record<string, unknown>;
};
type FoldedEntry = { lines: unknown[]; context?: ContextUsage; session_id?: string };
type EventsModule = {
  readonly applySessionEvent: (
    entry: FoldedEntry,
    event: EventEnvelopeLike,
    pushLine: (entry: unknown, cls: string, text: string) => void,
  ) => void;
};

// 92480 of a 272000-token window is the issue's worked example: it must read exactly ctx[34%/272k].
test('the chip states the whole reading, or nothing at all', async () => {
  const { formatContextChip } = (await import(chipModule)) as ChipModule;
  assert.equal(formatContextChip({ tokens: 92480, window: 272000 }), 'ctx[34%/272k]');
  assert.equal(formatContextChip({ tokens: 500000, window: 1000000 }), 'ctx[50%/1000k]');

  // Half a reading is not a reading. The window is resolved from the model catalogue and the token
  // count from the harness transcript, so either half can be missing on its own — and a missing
  // half must never be rendered as the confident 0% that would read as "plenty of room left".
  assert.equal(formatContextChip(undefined), null, 'no usage at all');
  assert.equal(formatContextChip({}), null, 'neither half known');
  assert.equal(formatContextChip({ tokens: 92480 }), null, 'window unknown');
  assert.equal(formatContextChip({ window: 272000 }), null, 'tokens unknown');
  assert.equal(formatContextChip({ tokens: 0, window: 272000 }), null, 'zero tokens');
  assert.equal(formatContextChip({ tokens: 92480, window: 0 }), null, 'zero window');
  assert.equal(formatContextChip({ tokens: -1, window: 272000 }), null, 'negative tokens');
  assert.equal(formatContextChip({ tokens: 92480, window: -1 }), null, 'negative window');
  assert.equal(formatContextChip({ tokens: Number.NaN, window: 272000 }), null, 'NaN tokens');
  assert.equal(formatContextChip({ tokens: 92480, window: Number.NaN }), null, 'NaN window');
  assert.equal(
    formatContextChip({ tokens: 92480, window: Number.POSITIVE_INFINITY }),
    null,
    'infinite window',
  );
});

test('an unknown reading leaves no element text behind', async () => {
  const { renderContextChip } = (await import(chipModule)) as ChipModule;
  const element: ChipElement = { hidden: true, textContent: 'stale' };

  renderContextChip({ element, entry: { context: { tokens: 92480, window: 272000 } } });
  assert.equal(element.hidden, false);
  assert.equal(element.textContent, 'ctx[34%/272k]');

  // Hidden AND cleared, from a showing state: a chip that only flipped `hidden` would keep the old
  // percentage in the accessibility tree and flash it on the next unhide.
  renderContextChip({ element, entry: { context: { tokens: 92480 } } });
  assert.equal(element.hidden, true, 'unknown window hides the chip');
  assert.equal(element.textContent, '', 'unknown window leaves no text');

  renderContextChip({ element, entry: { context: { tokens: 92480, window: 272000 } } });
  renderContextChip({ element, entry: {} });
  assert.equal(element.hidden, true, 'a session with no usage yet hides the chip');
  assert.equal(element.textContent, '');

  renderContextChip({ element, entry: undefined });
  assert.equal(element.hidden, true, 'the home screen with no session selected hides the chip');
  assert.equal(element.textContent, '');
});

test('session_context folds onto the entry and never becomes a transcript line', async () => {
  const events = (await import(new URL('ui/events.js', webRoot).href)) as EventsModule;
  const entry: FoldedEntry = { lines: [] };
  const pushed: string[] = [];
  const push = (_entry: unknown, _cls: string, text: string) => pushed.push(text);
  const base = { ts: '2026-08-31T08:00:00.000Z', stream_id: 'session:s1' };

  events.applySessionEvent(
    entry,
    {
      ...base,
      type: 'session_context',
      seq: 7,
      payload: {
        session_id: 's1',
        tokens: 92480,
        model: 'gpt-5.6-luna',
        context_window: 272000,
      },
    },
    push,
  );
  assert.deepEqual(entry.context, { tokens: 92480, window: 272000 });
  assert.equal(entry.session_id, 's1', 'the shared metadata fold still runs before the early exit');
  // The harness restates usage after every assistant record. Rendering it would stamp a ctx line
  // into the conversation on every turn, the noise session_state is already dropped for.
  assert.equal(pushed.length, 0, 'no session_context event may push a transcript line');

  // The window is resolved from the model catalogue, which can miss the model entirely. It has to
  // arrive on the entry as undefined so the chip hides rather than claiming 0%.
  events.applySessionEvent(
    entry,
    {
      ...base,
      type: 'session_context',
      seq: 8,
      payload: { session_id: 's1', tokens: 92480, model: 'some-unlisted-model' },
    },
    push,
  );
  assert.deepEqual(entry.context, { tokens: 92480, window: undefined });
  assert.equal(pushed.length, 0);
});

test('the chip ships under SEND and the shell cache is bumped to serve it', () => {
  const html = fs.readFileSync(new URL('index.html', webRoot), 'utf8');
  const sendAt = html.indexOf('id="compose-send"');
  const chipAt = html.indexOf('id="context-chip"');
  assert.ok(sendAt > 0, 'the send button is still in the composer');
  assert.ok(chipAt > sendAt, 'the context chip markup follows the send button');
  // Absent, not empty, until the first reading arrives.
  assert.match(html.slice(chipAt, html.indexOf('>', chipAt)), /\bhidden\b/);

  const serviceWorker = fs.readFileSync(new URL('sw.js', webRoot), 'utf8');
  assert.match(serviceWorker, /vibecodium-shell-v21/, 'the shell cache name is bumped');
  assert.match(serviceWorker, /'\/ui\/context-chip\.js'/, 'the chip module is precached');
});
