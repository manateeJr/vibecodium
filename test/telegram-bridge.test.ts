import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionBridge } from '../src/telegram/bridge.js';
import { createProjectsSubsystem } from '../src/projects/index.js';
import { createMachineSessionsSubsystem } from '../src/machine-sessions/index.js';
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

test('session bridge lists and resumes live machine sessions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-machine-'));
  const ompRoot = path.join(root, 'omp', 'sessions');
  const codexRoot = path.join(root, 'codex', 'sessions');
  const dataPath = path.join(root, 'events.sqlite');
  const newestMainRef = '019fe016-08d8-7651-9c21-653b5e1c1143';
  const oldestMainRef = '019fe016-08d8-7651-9c21-653b5e1c1144';
  const subagentRef = '01a04c8a-9a8a-7000-bd8e-6ee0c36ece1f';
  const now = Math.floor(Date.now() / 1000) * 1000;
  const newestMainMtime = now - 60_000;
  const oldestMainMtime = now - 120_000;
  const subagentMtime = now - 10_000;
  const writeSession = (file: string, lines: readonly unknown[], mtime: number): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
  };
  const sessionFile = (ref: string): string =>
    path.join(ompRoot, '-tmp', `2026-08-29T08-00-00-000Z_${ref}`, 'session.jsonl');

  writeSession(
    sessionFile(newestMainRef),
    [
      { type: 'title', title: 'Newest main session' },
      { type: 'session', cwd: '/workspace/newest' },
    ],
    newestMainMtime,
  );
  writeSession(
    sessionFile(oldestMainRef),
    [
      { type: 'title', title: 'Oldest main session' },
      { type: 'session', cwd: '/workspace/oldest' },
    ],
    oldestMainMtime,
  );
  writeSession(
    sessionFile(subagentRef),
    [
      { type: 'title', title: 'Subagent should be filtered' },
      { type: 'session_init', agent: 'task' },
      { type: 'session', cwd: '/workspace/subagent' },
    ],
    subagentMtime,
  );

  const previousEnvironment = {
    VIBECODIUM_PORT: process.env.VIBECODIUM_PORT,
    VIBECODIUM_DB_PATH: process.env.VIBECODIUM_DB_PATH,
    VIBECODIUM_EXTERNAL_ACTIVE_WINDOW_MS: process.env.VIBECODIUM_EXTERNAL_ACTIVE_WINDOW_MS,
  };
  process.env.VIBECODIUM_PORT = '0';
  process.env.VIBECODIUM_DB_PATH = dataPath;
  process.env.VIBECODIUM_EXTERNAL_ACTIVE_WINDOW_MS = '90000';

  let plane: ControlPlane | undefined;
  let planeStopped = false;
  try {
    const machineSessions = createMachineSessionsSubsystem({ ompRoot, codexRoot });
    plane = new ControlPlane({
      dataPath,
      port: 0,
      subsystems: [
        createSessionSubsystem({ machineSessions }),
        machineSessions,
        createProjectsSubsystem(),
      ],
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

    assert.deepEqual(await bridge.machineSessions(), [
      {
        source: 'omp',
        ref: newestMainRef,
        title: 'Newest main session',
        cwd: '/workspace/newest',
        updatedAt: new Date(newestMainMtime).toISOString(),
      },
      {
        source: 'omp',
        ref: oldestMainRef,
        title: 'Oldest main session',
        cwd: '/workspace/oldest',
        updatedAt: new Date(oldestMainMtime).toISOString(),
      },
    ]);

    const resumed = await bridge.resume({
      source: 'omp',
      ref: oldestMainRef,
      prompt: 'continue the old conversation',
    });
    assert.match(resumed.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(resumed.turn, 1);
    assert.ok((await bridge.list()).some((session) => session.sessionId === resumed.sessionId));

    await bridge.stop(resumed.sessionId);
    await plane.stop();
    planeStopped = true;
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
