import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionBridge } from '../src/telegram/bridge.js';
import { createProjectsSubsystem } from '../src/projects/index.js';
import { createSessionSubsystem } from '../src/session/index.js';
import { ControlPlane } from '../src/server/control-plane.js';

test('session bridge drives a live control plane', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-'));
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
  try {
    plane = new ControlPlane({
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

    assert.equal(await bridge.health(), true);
    assert.deepEqual(await bridge.projects(), [{ name: 'demo', path: projectPath }]);

    const opened = await bridge.open({
      cwd: projectPath,
      prompt: 'first prompt',
      project: 'demo',
    });
    assert.match(opened.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(opened.turn, 1);
    const firstProgress: Array<{ elapsedMs: number; toolCalls: number }> = [];
    const first = await bridge.watchTurn({
      sessionId: opened.sessionId,
      turn: opened.turn,
      onProgress: (progress) => firstProgress.push(progress),
      timeoutMs: 10_000,
    });
    assert.equal(first.status, 'complete');
    assert.notEqual(first.text, '');
    assert.ok(firstProgress.length > 0);

    const sent = await bridge.send({ sessionId: opened.sessionId, prompt: 'second prompt' });
    assert.equal(sent.turn, 2);
    const second = await bridge.watchTurn({
      sessionId: opened.sessionId,
      turn: sent.turn,
      onProgress: () => undefined,
      timeoutMs: 10_000,
    });
    assert.equal(second.status, 'complete');
    assert.notEqual(second.text, '');

    assert.equal(await bridge.stop(opened.sessionId), true);
    await plane.stop();
    planeStopped = true;
    assert.equal(await bridge.health(), false);
  } finally {
    try {
      if (plane !== undefined && !planeStopped) await plane.stop();
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
