import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import type { ActionRequestedPayload, EventEnvelope } from '../src/contracts/events.js';
import { createProjectsSubsystem } from '../src/projects/index.js';
import { createSessionSubsystem } from '../src/session/index.js';
import { answerAskHandler, answerAskSession } from '../src/session/answer-ask.js';
import type { SubsystemContext } from '../src/contracts/subsystem.js';
import { ControlPlane } from '../src/server/control-plane.js';
import { asAskRequest, askId } from '../src/telegram/ask-watch.js';
import type { AskQuestion } from '../src/telegram/ask-watch.js';
import { createSessionBridge } from '../src/telegram/bridge.js';
import { createSessionWatch } from '../src/telegram/session-watch.js';
import type { ObservedAsk, SessionBridge, TopicStore } from '../src/telegram/types.js';
import { createTestSocketDir } from './helpers/socket-dir.js';

const testSocketDir = createTestSocketDir();
after(() => testSocketDir.dispose());

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function payloadRecord(event: EventEnvelope): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
}

function askPayload(
  sessionId: string,
  askIdValue: string,
  questions: readonly AskQuestion[],
  extra: Record<string, unknown> = {},
): ActionRequestedPayload {
  return {
    request_id: `req-${askIdValue}`,
    action: 'omp.ask',
    scope: { session_id: sessionId },
    session_id: sessionId,
    turn: 1,
    ask_id: askIdValue,
    questions,
    source: 'omp-ask',
    requested_at: new Date().toISOString(),
    ...extra,
  } as ActionRequestedPayload;
}

const TWO_OPTION_QUESTIONS: readonly AskQuestion[] = [
  {
    id: 'q1',
    header: 'File the report?',
    question: 'Should I file the report now?',
    options: [{ label: "Don't file" }, { label: 'File it' }],
  },
];

async function startHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-ask-'));
  const projectPath = path.join(root, 'demo');
  const dataPath = path.join(root, 'events.sqlite');
  const projectsPath = path.join(root, 'projects.json');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(
    projectsPath,
    JSON.stringify({
      projects: [
        { name: 'demo', path: projectPath, description: '', quickActions: [], scope: 'project' },
      ],
    }),
  );
  const previousEnvironment = {
    VIBECODIUM_PORT: process.env.VIBECODIUM_PORT,
    VIBECODIUM_DB_PATH: process.env.VIBECODIUM_DB_PATH,
    VIBECODIUM_PROJECTS_PATH: process.env.VIBECODIUM_PROJECTS_PATH,
  };
  process.env.VIBECODIUM_PORT = '0';
  process.env.VIBECODIUM_DB_PATH = dataPath;
  process.env.VIBECODIUM_PROJECTS_PATH = projectsPath;
  const plane = new ControlPlane({
    dataPath,
    port: 0,
    subsystems: [createSessionSubsystem(), createProjectsSubsystem()],
  });
  const address = await plane.start();
  const bridge = createSessionBridge(
    {
      token: 'unused',
      allowedUserId: 1,
      chatId: 1,
      controlPlaneUrl: address.httpUrl,
      dbPath: dataPath,
      pollTimeoutSec: 1,
      progressThrottleMs: 100,
      turnTimeoutMs: 10_000,
    },
    'fake',
  );
  const cleanup = async (): Promise<void> => {
    await plane.stop().catch(() => undefined);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { plane, bridge, cleanup };
}

test('action_requested omp asks reach onAsk subscribers', async () => {
  const { plane, bridge, cleanup } = await startHarness();
  try {
    const sessionId = 'ask-session-routing';
    const observed: ObservedAsk[] = [];
    const unsubscribe = bridge.subscribeSession({
      sessionId,
      fromTail: true,
      onTurn: () => undefined,
      onAsk: (ask) => observed.push(ask),
    });
    try {
      // The subscription bootstraps from the stream tail asynchronously, so the
      // first appends can land before the snapshot; re-append with fresh ids
      // until one is observed live, then assert on what was delivered.
      const deadline = Date.now() + 10_000;
      let attempts = 0;
      while (observed.length === 0 && Date.now() < deadline) {
        attempts += 1;
        plane.eventStore.append(
          `session:${sessionId}`,
          'action_requested',
          askPayload(sessionId, `ask-route-${attempts}`, TWO_OPTION_QUESTIONS),
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(observed.length >= 1);
      for (const ask of observed) {
        assert.equal(ask.sessionId, sessionId);
        assert.equal(ask.turn, 1);
        assert.ok(asAskRequest(ask.payload));
      }
      const delivered = observed.length;
      // Unrelated action requests (proposal approvals) never reach onAsk.
      plane.eventStore.append(`session:${sessionId}`, 'action_requested', {
        request_id: 'proposal-1',
        action: 'proposal.submit',
        scope: { proposal_id: 'p1' },
      });
      // Asks for other sessions stay on their own subscription.
      plane.eventStore.append(
        'session:other-session',
        'action_requested',
        askPayload('other-session', 'ask-other', TWO_OPTION_QUESTIONS),
      );
      // Bounded wall-clock settle: the live socket needs real time (same reason
      // the sibling bridge tests poll instead of using fake timers).
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      assert.equal(observed.length, delivered);
    } finally {
      unsubscribe();
    }
  } finally {
    await cleanup();
  }
});

test('watchTurn surfaces the ask without closing the turn', async () => {
  const { plane, bridge, cleanup } = await startHarness();
  try {
    const sessionId = 'ask-session-wait';
    const observed: ObservedAsk[] = [];
    let settled = false;
    const resultPromise = bridge
      .watchTurn({
        sessionId,
        turn: 1,
        onProgress: () => undefined,
        timeoutMs: 400,
        onAsk: (ask) => observed.push(ask),
      })
      .then((result) => {
        settled = true;
        return result;
      });
    plane.eventStore.append(
      `session:${sessionId}`,
      'action_requested',
      askPayload(sessionId, 'ask-wait-1', TWO_OPTION_QUESTIONS),
    );
    await waitForCondition(() => observed.length === 1, 'ask during watch');
    const waited = observed[0];
    assert.ok(waited);
    assert.equal(askId(waited.payload), 'ask-wait-1');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false);
    const result = await resultPromise;
    assert.equal(result.status, 'timeout');

    // The normal completion path still works after an ask was surfaced.
    const completeSession = 'ask-session-complete';
    const completeObserved: ObservedAsk[] = [];
    const completePromise = bridge.watchTurn({
      sessionId: completeSession,
      turn: 1,
      onProgress: () => undefined,
      timeoutMs: 10_000,
      onAsk: (ask) => completeObserved.push(ask),
    });
    plane.eventStore.append(
      `session:${completeSession}`,
      'action_requested',
      askPayload(completeSession, 'ask-done-1', TWO_OPTION_QUESTIONS),
    );
    await waitForCondition(() => completeObserved.length >= 1, 'ask before completion');
    plane.eventStore.append(`session:${completeSession}`, 'turn_complete', {
      session_id: completeSession,
      turn: 1,
    });
    const completed = await completePromise;
    assert.equal(completed.status, 'complete');
  } finally {
    await cleanup();
  }
});

test('subscribeAsk relays the global ask feed and skips routeless payloads', async () => {
  const { plane, bridge, cleanup } = await startHarness();
  const observed: ObservedAsk[] = [];
  const unsubscribe = bridge.subscribeAsk((ask) => observed.push(ask));
  try {
    plane.eventStore.append(
      'session:ask-global-a',
      'action_requested',
      askPayload('ask-global-a', 'ask-global-1', TWO_OPTION_QUESTIONS),
    );
    await waitForCondition(() => observed.length === 1, 'global ask delivery');
    const globalFirst = observed[0];
    assert.ok(globalFirst);
    assert.equal(globalFirst.sessionId, 'ask-global-a');

    // Routeless payloads cannot be routed to a topic and are skipped.
    const routeless = askPayload('ask-global-a', 'ask-routeless', TWO_OPTION_QUESTIONS);
    const routelessRecord = routeless as unknown as Record<string, unknown>;
    delete routelessRecord.session_id;
    plane.eventStore.append('session:ask-global-a', 'action_requested', routeless);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.equal(observed.length, 1);
  } finally {
    unsubscribe();
    await cleanup();
  }
});

test('answerAsk posts approve and deny decisions to the session stream', async () => {
  const { plane, bridge, cleanup } = await startHarness();
  const observed: ObservedAsk[] = [];
  const unsubscribe = bridge.subscribeAsk((ask) => observed.push(ask));
  try {
    const sessionId = 'ask-session-answer';
    plane.eventStore.append(
      `session:${sessionId}`,
      'action_requested',
      askPayload(sessionId, 'ask-answer-1', TWO_OPTION_QUESTIONS),
    );
    await waitForCondition(() => observed.length === 1, 'ask cached for answer');

    const approved = await bridge.answerAsk({
      session_id: sessionId,
      ask_id: 'ask-answer-1',
      question_id: 'q1',
      option_index: 1,
    });
    assert.equal(approved, undefined);
    const denied = await bridge.answerAsk({
      session_id: sessionId,
      ask_id: 'ask-answer-1',
      question_id: 'q1',
      option_index: 0,
    });
    assert.deepEqual(denied, { status: 'denied' });
    // Unknown asks fail open to approve: the tap itself is consent.
    const fallback = await bridge.answerAsk({
      session_id: sessionId,
      ask_id: 'ask-unknown',
      question_id: 'q9',
      option_index: 0,
    });
    assert.equal(fallback, undefined);

    const events = plane.eventStore.read(`session:${sessionId}`, 0);
    const approvals = events.filter((event) => event.type === 'action_approved');
    const denials = events.filter((event) => event.type === 'action_denied');
    assert.equal(approvals.length, 2);
    assert.equal(denials.length, 1);
    const approval = approvals[0];
    assert.ok(approval);
    const denial = denials[0];
    assert.ok(denial);
    const approvalRecord = payloadRecord(approval);
    assert.equal(approvalRecord.ask_id, 'ask-answer-1');
    assert.equal(approvalRecord.question_id, 'q1');
    assert.equal(approvalRecord.option_index, 1);
    const denialRecord = payloadRecord(denial);
    assert.equal(denialRecord.ask_id, 'ask-answer-1');
    assert.equal(denialRecord.option_index, 0);
  } finally {
    unsubscribe();
    await cleanup();
  }
});

test('session watch forwards each ask once and honors markAsked', () => {
  type SubscribeParams = Parameters<SessionBridge['subscribeSession']>[0];
  const captured: SubscribeParams[] = [];
  const stubBridge = {
    subscribeSession: (params: SubscribeParams): (() => void) => {
      captured.push(params);
      return (): void => undefined;
    },
  } as unknown as SessionBridge;
  const stubStore: TopicStore = {
    bind: () => undefined,
    byThread: () => null,
    bySession: () => null,
    all: () => [],
    unbind: () => undefined,
    rename: () => undefined,
    getOffset: () => 0,
    setOffset: () => undefined,
    close: () => undefined,
  };
  const echoed: ObservedAsk[] = [];
  const watch = createSessionWatch({
    bridge: stubBridge,
    store: stubStore,
    echoTurn: () => Promise.resolve(),
    echoAsk: (ask) => {
      echoed.push(ask);
      return Promise.resolve();
    },
  });
  watch.watch('ask-watch-session');
  const params = captured[0];
  assert.ok(params);
  assert.ok(params.onAsk);
  const payload = askPayload('ask-watch-session', 'ask-dedupe-1', TWO_OPTION_QUESTIONS);
  params.onAsk({ sessionId: 'ask-watch-session', turn: 1, payload });
  params.onAsk({ sessionId: 'ask-watch-session', turn: 1, payload });
  assert.equal(echoed.length, 1);
  const echoedFirst = echoed[0];
  assert.ok(echoedFirst);
  assert.equal(askId(echoedFirst.payload), 'ask-dedupe-1');

  watch.markAsked('ask-watch-session', 'ask-premarked');
  const premarked = askPayload('ask-watch-session', 'ask-premarked', TWO_OPTION_QUESTIONS);
  params.onAsk({ sessionId: 'ask-watch-session', turn: 1, payload: premarked });
  assert.equal(echoed.length, 1);
  watch.unwatch('ask-watch-session');
  watch.stopAll();
});

test('answerAskSession validates input and reports resolution', () => {
  const appended: Array<{ streamId: string; type: string; payload: unknown }> = [];
  const resolveCalls: Array<{ sessionId: string; askId: string; approved: boolean }> = [];
  const deps: Parameters<typeof answerAskSession>[0] = {
    append: (streamId, type, payload) => {
      appended.push({ streamId, type, payload });
      return appended.length;
    },
    resolvePendingAsk: (sessionId, askId, decision) => {
      resolveCalls.push({ sessionId, askId, approved: decision.approved });
      return true;
    },
  };
  const approved = answerAskSession(deps, {
    session_id: 's1',
    ask_id: 'a1',
    question_id: 'q1',
    option_index: 2,
    approved: true,
  });
  assert.deepEqual(approved, { status: 'approved', resolved: true });
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.streamId, 'session:s1');
  assert.equal(appended[0]?.type, 'action_approved');
  assert.equal(resolveCalls.length, 1);

  const deniedDeps = {
    ...deps,
    resolvePendingAsk: () => false,
  };
  const denied = answerAskSession(deniedDeps, {
    session_id: 's1',
    ask_id: 'a2',
    question_id: 'q1',
    option_index: 0,
    approved: false,
  });
  assert.deepEqual(denied, { status: 'denied', resolved: false });

  assert.throws(
    () =>
      answerAskSession(deps, {
        session_id: '',
        ask_id: 'a3',
        question_id: 'q1',
        option_index: 0,
        approved: true,
      }),
    /session_id/,
  );
  assert.throws(
    () =>
      answerAskSession(deps, {
        session_id: 's1',
        ask_id: 'a3',
        question_id: 'q1',
        option_index: -1,
        approved: true,
      }),
    /option_index/,
  );
  assert.throws(
    () =>
      answerAskSession(deps, {
        session_id: 's1',
        ask_id: 'a3',
        question_id: 'q1',
        option_index: 0,
        approved: 'yes',
      }),
    /approved/,
  );
});

test('answerAskHandler resolves through a live manager host', () => {
  const appended: Array<{ streamId: string; type: string }> = [];
  const append = ((streamId: string, type: string, payload: unknown) => {
    void payload;
    appended.push({ streamId, type });
    return appended.length;
  }) as unknown as Pick<SubsystemContext, 'append'>['append'];
  let resolvedAsk: string | null = null;
  const fakeManager = {
    workers: new Map([
      [
        's1',
        {
          tailer: {
            resolveAsk: (askId: string, decision: { approved: boolean }) => {
              void decision;
              resolvedAsk = askId;
              return true;
            },
          },
        },
      ],
    ]),
  };
  const result = answerAskHandler(
    { append },
    fakeManager,
  )({
    session_id: 's1',
    ask_id: 'a1',
    question_id: 'q1',
    option_index: 0,
    approved: true,
  });
  assert.deepEqual(result, { status: 'approved', resolved: true });
  assert.equal(resolvedAsk, 'a1');
  assert.deepEqual(appended, [{ streamId: 'session:s1', type: 'action_approved' }]);

  // Absent hops degrade to event-only audit records instead of throwing.
  const missing = answerAskHandler(
    { append },
    null,
  )({
    session_id: 's9',
    ask_id: 'a9',
    question_id: 'q1',
    option_index: 0,
    approved: false,
  });
  assert.deepEqual(missing, { status: 'denied', resolved: false });
});
