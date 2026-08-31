import assert from 'node:assert/strict';
import test from 'node:test';

// Browser modules are served directly from web/ rather than emitted by tsc, so these tests load the
// shipped files by URL after compilation.
const webRoot = new URL('../../web/', import.meta.url);

type WorkState = {
  readonly lastUserSeq: number;
  readonly lastReplySeq: number;
  readonly working: boolean;
};
type SessionEvent = {
  readonly type: string;
  readonly seq: number;
  readonly payload?: Record<string, unknown>;
};
type SessionStateModule = {
  readonly IDLE_WORK_STATE: WorkState;
  readonly applyWorkEvent: (state: WorkState, event: SessionEvent) => WorkState;
};
type Actions = {
  readonly submitCompose: () => Promise<void>;
  readonly stopSession: () => Promise<void>;
};
type ActionsModule = {
  readonly createActions: (options: Record<string, unknown>) => Actions;
};

async function loadSessionState(): Promise<SessionStateModule> {
  return (await import(new URL('lib/session-state.js', webRoot).href)) as SessionStateModule;
}

async function loadActions(): Promise<ActionsModule> {
  return (await import(new URL('ui/actions.js', webRoot).href)) as ActionsModule;
}

function derive(module: SessionStateModule, events: readonly SessionEvent[]): WorkState {
  return events.reduce(
    (state, event) => module.applyWorkEvent(state, event),
    module.IDLE_WORK_STATE,
  );
}

test('authoritative resumable and closed states clear a missed turn and fence stale events', async () => {
  const sessionState = await loadSessionState();
  const working = derive(sessionState, [{ type: 'session_input', seq: 5 }]);
  assert.equal(working.working, true);

  for (const [seq, state, reason] of [
    [6, 'resumable', 'reaped'],
    [7, 'resumable', 'reconciled'],
    [8, 'closed', 'shutdown'],
  ] as const) {
    const idle = sessionState.applyWorkEvent(working, {
      type: 'session_state',
      seq,
      payload: { session_id: 'session-1', state, reason },
    });
    assert.equal(idle.working, false);
    assert.equal(idle.lastUserSeq, 5);
    assert.equal(idle.lastReplySeq, seq);
    assert.equal(
      sessionState.applyWorkEvent(idle, { type: 'session_output', seq: 4 }).working,
      false,
      'a stale reply cannot resurrect authoritative idle state',
    );
  }
});

test('busy SEND forwards immediately and leaves the local turn working', async () => {
  const actionsModule = await loadActions();
  const entry = {
    kind: 'session',
    status: 'running',
    stream_id: 'session:session-1',
    session_id: 'session-1',
    busy: true,
    work: { lastUserSeq: 5, lastReplySeq: 2, working: true },
    lines: [],
  };
  const sessions = new Map([[entry.stream_id, entry]]);
  const sends: unknown[] = [];
  let resetCount = 0;
  const actions = actionsModule.createActions({
    client: {
      sendMessage: async (args: unknown) => {
        sends.push(args);
        return { stream_id: entry.stream_id };
      },
    },
    elements: { harness: { value: 'omp' } },
    sessions,
    state: { opening: false, stopping: false, resuming: false, interrupting: false },
    getSelectedStreamId: () => entry.stream_id,
    getActiveProject: () => undefined,
    getModel: () => '',
    connection: () => ({ baseUrl: 'http://localhost' }),
    resetInput: () => {
      resetCount += 1;
    },
    getPrompt: () => 'steer without stopping',
    setStatus: () => undefined,
    refreshControls: () => undefined,
    renderSessions: () => undefined,
    renderStream: () => undefined,
    selectStream: () => undefined,
    ensureEntry: () => undefined,
    pushLine: () => undefined,
    appendError: () => undefined,
    errorMessage: (error: unknown) => String(error),
    notify: () => undefined,
    reloadSessions: async () => undefined,
  });

  await actions.submitCompose();
  assert.equal(sends.length, 1, 'busy sends reach the session transport');
  assert.deepEqual(sends[0], {
    session_id: 'session-1',
    prompt: 'steer without stopping',
    idempotency_key: (sends[0] as { idempotency_key: string }).idempotency_key,
  });
  assert.equal(typeof (sends[0] as { idempotency_key: string }).idempotency_key, 'string');
  assert.equal(resetCount, 1);
  assert.equal(entry.busy, true, 'sending does not clear genuine busy state');
  assert.equal(entry.work.working, true);
});

test('STOP clears stale local work before an already-stopped response', async () => {
  const actionsModule = await loadActions();
  const entry = {
    kind: 'session',
    status: 'running',
    stream_id: 'session:session-2',
    session_id: 'session-2',
    busy: true,
    work: { lastUserSeq: 9, lastReplySeq: 3, working: true },
    lines: [],
  };
  const sessions = new Map([[entry.stream_id, entry]]);
  let finishStop: (result: { stopped: boolean }) => void = () => undefined;
  const stopResult = new Promise<{ stopped: boolean }>((resolve) => {
    finishStop = resolve;
  });
  let streamRenders = 0;
  const actions = actionsModule.createActions({
    client: { stopSession: () => stopResult },
    elements: { harness: { value: 'omp' } },
    sessions,
    state: { opening: false, stopping: false, resuming: false, interrupting: false },
    getSelectedStreamId: () => entry.stream_id,
    getActiveProject: () => undefined,
    getModel: () => '',
    connection: () => ({ baseUrl: 'http://localhost' }),
    resetInput: () => undefined,
    getPrompt: () => '',
    setStatus: () => undefined,
    refreshControls: () => undefined,
    renderSessions: () => undefined,
    renderStream: () => {
      streamRenders += 1;
    },
    selectStream: () => undefined,
    ensureEntry: () => undefined,
    pushLine: () => undefined,
    appendError: () => undefined,
    errorMessage: (error: unknown) => String(error),
    notify: () => undefined,
    reloadSessions: async () => undefined,
  });

  const stopping = actions.stopSession();
  assert.equal(entry.busy, false, 'STOP resets busy before transport completion');
  assert.equal(entry.work.working, false);
  assert.equal(entry.work.lastReplySeq, 9, 'the reset preserves the sequence fence');
  assert.ok(streamRenders > 0, 'STOP immediately rerenders the cleared transcript');
  finishStop({ stopped: false });
  await stopping;
  assert.equal(entry.status, 'done');
});
