import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlane } from '../../dist/src/server/control-plane.js';
import { createFilesSubsystem } from '../../dist/src/files/index.js';
import { createMachineSessionsSubsystem } from '../../dist/src/machine-sessions/index.js';
import { createProjectsSubsystem } from '../../dist/src/projects/index.js';
import { SessionTable } from '../../dist/src/session/session-table.js';
import { SessionSubsystem } from '../../dist/src/session/index.js';
import { createSubstrateClient } from '../../dist/src/substrate/index.js';
import { ensureSubstrateBinary, installFakeOmpHarness } from '../soak-fixture.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const botEntrypoint = path.join(repositoryRoot, 'dist/src/telegram/main.js');
const normalIdleTimeoutMs = 31 * 60 * 1000;

export function createReplayRuntime({ project, provider }) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'vibecodium-telegram-replay-'));
  const projectPath =
    project.path === undefined ? path.join(root, 'project') : path.resolve(project.path);
  const storageRoot = path.join(root, 'sessions');
  const sharedDir = path.join(root, 'shared');
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'vc-telegram-'));
  const machineRoot = path.join(root, 'machine');
  const databasePath = path.join(root, 'control-plane.sqlite');
  const projectsPath = path.join(root, 'projects.json');
  const telegramDbPath = path.join(root, 'telegram.sqlite');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(machineRoot, { recursive: true });
  fs.writeFileSync(
    projectsPath,
    JSON.stringify({
      projects: [
        {
          name: project.name,
          path: projectPath,
          description: 'Telegram replay project',
          quickActions: [],
          scope: 'project',
        },
      ],
    }),
  );

  const substrateSetup = ensureSubstrateBinary(repositoryRoot);
  if (!substrateSetup.available) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
    throw new Error(
      `substrate unavailable; run npm run setup:substrate${substrateSetup.output ? `\n${substrateSetup.output}` : ''}`,
    );
  }
  const fakeBin = provider === 'fake' ? installFakeOmpHarness(root) : undefined;
  const previousEnvironment = new Map(
    [
      'VIBECODIUM_PORT',
      'VIBECODIUM_DB_PATH',
      'VIBECODIUM_PROJECTS_PATH',
      'VIBECODIUM_SHARED_DIR',
      'VIBECODIUM_SESSION_STORAGE_ROOT',
      'ABDUCO_SOCKET_DIR',
      'PATH',
    ].map((name) => [name, process.env[name]]),
  );
  process.env.VIBECODIUM_PORT = '0';
  process.env.VIBECODIUM_DB_PATH = databasePath;
  process.env.VIBECODIUM_PROJECTS_PATH = projectsPath;
  process.env.VIBECODIUM_SHARED_DIR = sharedDir;
  process.env.VIBECODIUM_SESSION_STORAGE_ROOT = storageRoot;
  process.env.ABDUCO_SOCKET_DIR = socketDir;
  const localBin = path.join(homedir(), '.local', 'bin');
  const pathEntries = [
    ...(fakeBin === undefined ? [] : [fakeBin]),
    localBin,
    process.env.PATH ?? '',
  ].filter((entry) => entry.length > 0);
  process.env.PATH = pathEntries.join(path.delimiter);

  const substrates = new Set();
  let port;
  let runtime;
  let cleaned = false;

  function createRuntime(fastReaper, idleTimeoutOverride) {
    const table = new SessionTable({ filename: databasePath });
    const substrate = createSubstrateClient({ socketDir });
    substrates.add(substrate);
    const machine = createMachineSessionsSubsystem({
      ompRoot: path.join(machineRoot, 'omp'),
      codexRoot: path.join(machineRoot, 'codex'),
    });
    const sessions = new SessionSubsystem({
      substrate,
      sessionTable: table,
      sessionStorageRoot: storageRoot,
      machineSessions: machine,
      idleTimeoutMs: idleTimeoutOverride ?? (fastReaper ? 600 : normalIdleTimeoutMs),
      reaperIntervalMs:
        fastReaper || idleTimeoutOverride !== undefined
          ? fastReaper
            ? 100
            : 60 * 60 * 1000
          : 60 * 1000,
    });
    const files = createFilesSubsystem({ sharedDir });
    const projects = createProjectsSubsystem({ registryPath: projectsPath });
    const plane = new ControlPlane({
      dataPath: databasePath,
      port: port ?? 0,
      subsystems: [sessions, files, machine, projects],
    });
    return { plane, table, substrate, sessions, stopped: false, address: undefined };
  }

  async function startRuntime(fastReaper = false, idleTimeoutOverride) {
    const next = createRuntime(fastReaper, idleTimeoutOverride);
    next.address = await next.plane.start();
    if (port === undefined) port = next.address.port;
    if (next.address.port !== port) {
      await next.plane.stop();
      next.table.close();
      throw new Error(`control plane changed ports from ${port} to ${next.address.port}`);
    }
    runtime = next;
    await next.sessions.reconcile();
    return next;
  }

  async function stopRuntime(target = runtime) {
    if (target === undefined || target.stopped) return;
    await target.plane.stop();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    target.table.close();
    target.stopped = true;
    if (runtime === target) runtime = undefined;
  }

  async function killSubstrateSessions() {
    for (const substrate of substrates) {
      const sessions = await substrate.listSessions().catch(() => []);
      await Promise.all(
        sessions.map((session) => substrate.kill(session.name).catch(() => undefined)),
      );
    }
  }

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    let cleanupError;
    try {
      await stopRuntime();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await killSubstrateSessions();
    } catch (error) {
      cleanupError ??= error;
    }
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
  }

  return {
    root,
    projectName: project.name,
    projectPath,
    storageRoot,
    socketDir,
    databasePath,
    projectsPath,
    telegramDbPath,
    providerName: provider === 'fake' ? 'omp' : provider,
    botEntrypoint,
    get port() {
      return port;
    },
    get runtime() {
      return runtime;
    },
    startRuntime,
    stopRuntime,
    killSubstrateSessions,
    cleanup,
  };
}

export function spawnTelegramBot(runtime, stubPort, ids) {
  const child = spawn(process.execPath, [runtime.botEntrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      VIBECODIUM_DB_PATH: runtime.databasePath,
      VIBECODIUM_PROJECTS_PATH: runtime.projectsPath,
      VIBECODIUM_TELEGRAM_TOKEN: 'replay-token',
      VIBECODIUM_TELEGRAM_USER_ID: String(ids.userId),
      VIBECODIUM_TELEGRAM_CHAT_ID: String(ids.chatId),
      VIBECODIUM_URL: `http://127.0.0.1:${runtime.port}`,
      VIBECODIUM_TELEGRAM_DB_PATH: runtime.telegramDbPath,
      VIBECODIUM_TELEGRAM_API_BASE: `http://127.0.0.1:${stubPort}`,
      VIBECODIUM_TELEGRAM_PROVIDER: runtime.providerName,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
}

export async function stopTelegramBot(child) {
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timeout = new Promise((_, reject) =>
    globalThis.setTimeout(() => reject(new Error('Telegram bot did not stop')), 8_000),
  );
  try {
    await Promise.race([exited, timeout]);
  } catch {
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([exited, new Promise((resolve) => globalThis.setTimeout(resolve, 2_000))]);
  }
}
