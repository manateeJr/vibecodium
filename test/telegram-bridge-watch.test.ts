import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createClient } from '../src/client/index.js';
import { createProjectsSubsystem } from '../src/projects/index.js';
import { createSessionSubsystem } from '../src/session/index.js';
import { ControlPlane } from '../src/server/control-plane.js';
import { createSessionBridge } from '../src/telegram/bridge.js';
import type { ObservedTurn, SessionBridge } from '../src/telegram/types.js';
import { createTestSocketDir } from './helpers/socket-dir.js';

const testSocketDir = createTestSocketDir();
after(() => testSocketDir.dispose());

// Real HTTP/WebSocket integration needs a bounded wall-clock poll, not fake timers.
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

async function waitForAsyncCondition(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

test('session bridge watches live turns from the current tail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-watch-'));
  const projectPath = path.join(root, 'demo');
  const dataPath = path.join(root, 'events.sqlite');
  const projectsPath = path.join(root, 'projects.json');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(
    projectsPath,
    JSON.stringify({
      projects: [
        {
          name: 'demo',
          path: projectPath,
          description: '',
          quickActions: [],
          scope: 'project',
        },
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

  let plane: ControlPlane | undefined;
  let planeStopped = false;
  let bridge: SessionBridge | undefined;
  let sessionId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    plane = new ControlPlane({
      dataPath,
      port: 0,
      subsystems: [createSessionSubsystem(), createProjectsSubsystem()],
    });
    const address = await plane.start();
    const activeBridge = createSessionBridge(
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
    bridge = activeBridge;
    const secondClient = createClient({ baseUrl: address.httpUrl });

    const opened = await activeBridge.open({
      cwd: projectPath,
      prompt: 'initial prompt',
      project: 'demo',
    });
    const activeSessionId = opened.sessionId;
    sessionId = activeSessionId;
    const initial = await activeBridge.watchTurn({
      sessionId: activeSessionId,
      turn: opened.turn,
      onProgress: () => undefined,
      timeoutMs: 10_000,
    });
    assert.equal(initial.status, 'complete');

    const observedTurns: ObservedTurn[] = [];
    const states: string[] = [];
    unsubscribe = activeBridge.subscribeSession({
      sessionId: activeSessionId,
      fromTail: true,
      onTurn: (turn) => observedTurns.push(turn),
      onState: (state) => states.push(state),
    });

    // This read also gives the async tail bootstrap time to finish before the peer sends.
    await waitForAsyncCondition(
      async () => (await activeBridge.openTurn(activeSessionId)) === null,
      'session tail bootstrap',
    );
    const prompt = `pc typed live turn ${Array.from({ length: 1_000 }, () => 'word').join(' ')}`;
    const sendPromise = secondClient.sendMessage({ session_id: activeSessionId, prompt });
    let openTurn: number | null = null;
    await waitForAsyncCondition(async () => {
      openTurn = await activeBridge.openTurn(activeSessionId);
      return openTurn !== null;
    }, 'turn to become open');
    const sent = await sendPromise;
    assert.equal(openTurn, sent.turn);

    await waitForCondition(() => observedTurns.length === 1, 'observed turn');
    const observed = observedTurns[0];
    assert.ok(observed);
    assert.equal(observed.sessionId, activeSessionId);
    assert.equal(observed.turn, sent.turn);
    assert.equal(observed.prompt, prompt);
    assert.notEqual(observed.text, '');
    assert.notEqual(observed.completedAt, '');
    await waitForAsyncCondition(
      async () => (await activeBridge.openTurn(activeSessionId)) === null,
      'turn completion',
    );

    unsubscribe();
    unsubscribe();
    const countAfterUnsubscribe = observedTurns.length;
    await secondClient.sendMessage({
      session_id: activeSessionId,
      prompt: 'after unsubscribe turn',
    });
    await waitForAsyncCondition(
      async () => (await activeBridge.openTurn(activeSessionId)) === null,
      'post-unsubscribe turn completion',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observedTurns.length, countAfterUnsubscribe);
  } finally {
    unsubscribe?.();
    if (bridge !== undefined && sessionId !== undefined)
      await bridge.stop(sessionId).catch(() => undefined);
    if (plane !== undefined && !planeStopped) {
      await plane.stop();
      planeStopped = true;
    }
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
