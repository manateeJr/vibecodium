import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateCreateOptions,
  SubstrateKey,
  SubstrateOutputListener,
  SubstrateSessionInfo,
} from '../src/contracts/substrate-contract.js';
import { SessionTable } from '../src/session/session-table.js';
import { createSessionBridge } from '../src/telegram/bridge.js';
import { createProjectsSubsystem } from '../src/projects/index.js';
import { createMachineSessionsSubsystem } from '../src/machine-sessions/index.js';
import { createSessionSubsystem } from '../src/session/index.js';
import { ControlPlane } from '../src/server/control-plane.js';
import { createTestSocketDir } from './helpers/socket-dir.js';

const testSocketDir = createTestSocketDir();
after(() => testSocketDir.dispose());
class FakePersistentSubstrate implements SubstrateClient {
  private readonly sessions = new Map<
    string,
    {
      readonly transcriptPath: string;
      live: boolean;
      pendingPrompt: string | undefined;
      composerPrompt: string | undefined;
    }
  >();
  public readonly killedNames: string[] = [];

  public async createSession(
    name: string,
    argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo> {
    void options;
    const sessionDirFlag = argv.indexOf('--session-dir');
    const storageDir = sessionDirFlag < 0 ? undefined : argv[sessionDirFlag + 1];
    if (storageDir === undefined) throw new Error('fake substrate missing session directory');
    fs.mkdirSync(storageDir, { recursive: true });
    const isResume = argv.includes('--resume');
    const prompt = argv.at(-1);
    const state = {
      transcriptPath: path.join(storageDir, 'session.jsonl'),
      live: true,
      pendingPrompt: isResume ? prompt : undefined,
      composerPrompt: undefined,
    };
    this.sessions.set(name, state);
    if (!isResume && prompt !== undefined) this.appendTurn(state, prompt);
    return { name, live: true };
  }

  public async attach(name: string): Promise<SubstrateAttachment> {
    const state = this.sessions.get(name);
    if (!state?.live) throw new Error(`fake substrate session is not live: ${name}`);
    return { name, detach: async () => undefined };
  }

  public async write(name: string, bytes: Uint8Array): Promise<void> {
    const state = this.sessions.get(name);
    if (!state?.live) throw new Error(`fake substrate session is not live: ${name}`);
    const text = new TextDecoder().decode(bytes);
    const escape = String.fromCharCode(27);
    const startMarker = `${escape}[200~`;
    const endMarker = `${escape}[201~`;
    if (text.startsWith(startMarker) && text.endsWith(endMarker))
      state.composerPrompt = text.slice(startMarker.length, -endMarker.length);
  }

  public async sendKey(name: string, key: SubstrateKey): Promise<void> {
    const state = this.sessions.get(name);
    if (!state?.live) throw new Error(`fake substrate session is not live: ${name}`);
    if (key !== 'enter' || state.composerPrompt === undefined) return;
    const prompt = state.composerPrompt;
    state.composerPrompt = undefined;
    this.appendTurn(state, prompt);
  }

  public onOutput(listener: SubstrateOutputListener): () => void {
    void listener;
    return () => undefined;
  }

  public async isLive(name: string): Promise<boolean> {
    return this.sessions.get(name)?.live === true;
  }

  public async kill(name: string): Promise<void> {
    const state = this.sessions.get(name);
    if (state) state.live = false;
    this.killedNames.push(name);
  }

  public async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    for (const state of this.sessions.values()) {
      if (!state.live || state.pendingPrompt === undefined) continue;
      const prompt = state.pendingPrompt;
      state.pendingPrompt = undefined;
      this.appendTurn(state, prompt);
    }
    return [...this.sessions.entries()]
      .filter(([, state]) => state.live)
      .map(([name]) => ({ name, live: true }));
  }

  private appendTurn(
    state: {
      readonly transcriptPath: string;
      live: boolean;
      pendingPrompt: string | undefined;
      composerPrompt: string | undefined;
    },
    prompt: string,
  ): void {
    const records = [
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `echo:${prompt}` }],
          stopReason: 'stop',
        },
      },
    ];
    fs.appendFileSync(
      state.transcriptPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
  }
}

test('session bridge ignores stale replay after a cold resume', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-cold-'));
  const projectPath = path.join(root, 'demo');
  const dataPath = path.join(root, 'events.sqlite');
  const sessionDataPath = path.join(root, 'sessions.sqlite');
  const projectsPath = path.join(root, 'projects.json');
  const socketDir = path.join(root, 'abduco');
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
    ABDUCO_SOCKET_DIR: process.env.ABDUCO_SOCKET_DIR,
  };
  process.env.VIBECODIUM_PORT = '0';
  process.env.VIBECODIUM_DB_PATH = dataPath;
  process.env.VIBECODIUM_PROJECTS_PATH = projectsPath;
  process.env.ABDUCO_SOCKET_DIR = socketDir;

  const substrate = new FakePersistentSubstrate();
  const sessionTable = new SessionTable({ filename: sessionDataPath });
  const sessions = createSessionSubsystem({
    substrate,
    sessionTable,
    sessionStorageRoot: path.join(root, 'sessions'),
    idleTimeoutMs: 0,
    reaperIntervalMs: 60_000,
  });
  let plane: ControlPlane | undefined;
  try {
    plane = new ControlPlane({
      dataPath,
      port: 0,
      subsystems: [sessions, createProjectsSubsystem()],
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
      'omp',
    );

    const opened = await bridge.open({
      cwd: projectPath,
      prompt: 'old turn one',
      project: 'demo',
    });
    const first = await bridge.watchTurn({
      sessionId: opened.sessionId,
      turn: opened.turn,
      onProgress: () => undefined,
      timeoutMs: 10_000,
    });
    assert.equal(first.status, 'complete');
    assert.equal(first.text, 'echo:old turn one');

    const warmSend = await bridge.send({
      sessionId: opened.sessionId,
      prompt: 'warm turn two',
    });
    assert.equal(warmSend.turn, 2);
    const second = await bridge.watchTurn({
      sessionId: opened.sessionId,
      turn: warmSend.turn,
      onProgress: () => undefined,
      timeoutMs: 10_000,
    });
    assert.equal(second.status, 'complete');
    assert.equal(second.text, 'echo:warm turn two');

    assert.deepEqual(await sessions.reapIdle(), [opened.sessionId]);
    assert.equal(sessionTable.get(opened.sessionId)?.state, 'resumable');
    assert.deepEqual(substrate.killedNames, [`substrate-${opened.sessionId}`]);

    const coldSend = await bridge.send({
      sessionId: opened.sessionId,
      prompt: 'new cold turn three',
    });
    assert.equal(coldSend.turn, 3);
    const resumed = await bridge.watchTurn({
      sessionId: opened.sessionId,
      turn: coldSend.turn,
      onProgress: () => undefined,
      timeoutMs: 10_000,
    });
    assert.equal(resumed.text, 'echo:new cold turn three');
  } finally {
    try {
      if (plane !== undefined) await plane.stop();
    } finally {
      sessionTable.close();
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

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
