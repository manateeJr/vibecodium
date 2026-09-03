#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { socketPathCandidates } from '../dist/src/substrate/paths.js';
import { fileURLToPath } from 'node:url';
import { ControlPlane } from '../dist/src/server/control-plane.js';
import { createFilesSubsystem } from '../dist/src/files/index.js';
import { createMachineSessionsSubsystem } from '../dist/src/machine-sessions/index.js';
import { SessionTable } from '../dist/src/session/session-table.js';
import { SessionSubsystem } from '../dist/src/session/index.js';
import { createSubstrateClient } from '../dist/src/substrate/index.js';
import { writeEvidence } from './evidence.mjs';
import { ensureSubstrateBinary, installFakeOmpHarness } from './soak-fixture.mjs';
import { runScenario } from './soak-scenarios.mjs';
import * as soak from '../dist/src/soak/helpers.js';

const options = soak.parseSoakArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(tmpdir(), 'vibecodium-soak-'));
const projectDir = path.join(root, 'project');
const storageRoot = path.join(root, 'sessions');
const sharedDir = path.join(root, 'shared');
const socketDir = fs.mkdtempSync(path.join('/tmp', 'vc-soak-'));
const worstCaseSocketPath = socketPathCandidates(`substrate-${'0'.repeat(36)}`, { socketDir })[0];
if (worstCaseSocketPath === undefined || Buffer.byteLength(worstCaseSocketPath) >= 108) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(socketDir, { recursive: true, force: true });
  throw new Error(`soak socket path exceeds abduco's 108-byte limit: ${worstCaseSocketPath}`);
}
const machineRoot = path.join(root, 'machine');
const databasePath = path.join(root, 'control-plane.sqlite');
const projectsPath = path.join(root, 'projects.json');
const targetDuration = soak.soakDurationMs(options);
const eventTimeoutMs = options.provider === 'fake' ? 15_000 : 180_000;
const startedAt = new Date();
const startedAtMs = startedAt.getTime();
const outputLines = [];
const state = {
  runtime: undefined,
  sessionId: undefined,
  streamId: undefined,
  label: undefined,
  cycle: 0,
  stopped: false,
  lastEvents: [],
  report: undefined,
  recordedSessionIds: new Set(),
  substrateNames: new Set(),
};
const environment = new Map(
  [
    'VIBECODIUM_PORT',
    'VIBECODIUM_DB_PATH',
    'VIBECODIUM_PROJECTS_PATH',
    'VIBECODIUM_SHARED_DIR',
    'VIBECODIUM_SESSION_STORAGE_ROOT',
    'ABDUCO_SOCKET_DIR',
    'PATH',
  ].map((key) => [key, process.env[key]]),
);
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(storageRoot, { recursive: true });
fs.mkdirSync(machineRoot, { recursive: true });
fs.mkdirSync(sharedDir, { recursive: true });
fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
process.env.VIBECODIUM_PORT = '0';
process.env.VIBECODIUM_DB_PATH = databasePath;
process.env.VIBECODIUM_PROJECTS_PATH = projectsPath;
process.env.VIBECODIUM_SHARED_DIR = sharedDir;
process.env.VIBECODIUM_SESSION_STORAGE_ROOT = storageRoot;
process.env.ABDUCO_SOCKET_DIR = socketDir;
const substrateSetup = ensureSubstrateBinary(repositoryRoot);
const substrateReady = substrateSetup.available;
function sleep(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
function log(message) {
  const line = `[soak] ${message}`;
  outputLines.push(line);
  process.stdout.write(`${line}\n`);
}
if (substrateSetup.output) log(`substrate setup: ${substrateSetup.output}`);
if (options.provider === 'omp' && !substrateReady)
  throw new Error('OMP soak requires the vendored abduco binary; run npm run setup:substrate');
if (options.provider === 'fake' && substrateReady) {
  const fakeBin = installFakeOmpHarness(root);
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`;
}
function recordValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} returned an invalid object`);
  return value;
}
async function readJson(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned HTTP ${response.status} with invalid JSON`);
  }
  if (!response.ok) {
    const detail = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return body;
}
async function command(name, args) {
  const runtime = state.runtime;
  if (!runtime) throw new Error(`cannot call ${name} without a running control plane`);
  const response = await globalThis.fetch(`${runtime.address.httpUrl}/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = recordValue(await readJson(response, name), name);
  if (!('value' in body)) throw new Error(`${name} response omitted value`);
  return body.value;
}
async function readEvents(streamId = state.streamId) {
  const runtime = state.runtime;
  if (!runtime || !streamId) throw new Error('cannot read events without a session');
  const url = new globalThis.URL('/events', `${runtime.address.httpUrl}/`);
  url.searchParams.set('stream_id', streamId);
  url.searchParams.set('from_seq', '0');
  const body = recordValue(await readJson(await globalThis.fetch(url), 'events'), 'events');
  if (!Array.isArray(body.events)) throw new Error('events response omitted events');
  if (streamId === state.streamId) state.lastEvents = body.events;
  return body.events;
}
async function waitForEvents(predicate, label, streamId = state.streamId) {
  const deadline = Date.now() + eventTimeoutMs;
  let events = await readEvents(streamId);
  while (Date.now() < deadline) {
    if (predicate(events)) return events;
    await sleep(options.provider === 'fake' ? 25 : 100);
    events = await readEvents(streamId);
  }
  throw new Error(
    `timed out waiting for ${label}; events=${events.map((event) => event?.type ?? '?').join(',')}`,
  );
}
async function openRecordedSession(provider, prompt) {
  const opened = recordValue(
    await command('session.open', {
      provider,
      prompt,
      cwd: projectDir,
      project: 'soak-project',
      origin: 'operator',
    }),
    'session.open',
  );
  if (typeof opened.session_id !== 'string' || typeof opened.stream_id !== 'string')
    throw new Error('session.open omitted session identifiers');
  state.recordedSessionIds.add(opened.session_id);
  if (provider === 'omp') state.substrateNames.add(`substrate-${opened.session_id}`);
  await waitForEvents(
    (events) => events.some((event) => event?.type === 'turn_complete'),
    `initial turn_complete ${opened.session_id}`,
    opened.stream_id,
  );
  return opened;
}
async function sendTurn(prompt, sessionId = state.sessionId, streamId = `session:${sessionId}`) {
  const result = recordValue(
    await command('session.send', { session_id: sessionId, prompt }),
    'session.send',
  );
  if (typeof result.turn !== 'number') throw new Error('session.send omitted turn');
  await waitForEvents(
    (events) =>
      events.some(
        (event) => event?.type === 'turn_complete' && event.payload?.turn === result.turn,
      ),
    `turn_complete turn=${result.turn}`,
    streamId,
  );
  return result.turn;
}
async function stopRecordedSession(sessionId, streamId, allowMissing = false) {
  const result = recordValue(
    await command('session.stop', { session_id: sessionId }),
    'session.stop',
  );
  if (result.stopped !== true) {
    if (allowMissing) return false;
    throw new Error(`session.stop did not stop ${sessionId}`);
  }
  await waitForEvents(
    (events) => events.some((event) => event?.type === 'session_complete'),
    `session_complete ${sessionId}`,
    streamId,
  );
  return true;
}
function createRuntime(fastReaper) {
  const table = new SessionTable({ filename: databasePath });
  const substrate = createSubstrateClient({ socketDir });
  const machine = createMachineSessionsSubsystem({
    ompRoot: path.join(machineRoot, 'omp'),
    codexRoot: path.join(machineRoot, 'codex'),
  });
  const sessions = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: storageRoot,
    machineSessions: machine,
    idleTimeoutMs: fastReaper ? 600 : Math.max(31 * 60 * 1000, targetDuration + 60 * 1000),
    reaperIntervalMs: 100,
  });
  const files = createFilesSubsystem({ sharedDir });
  const plane = new ControlPlane({
    dataPath: databasePath,
    port: 0,
    subsystems: [sessions, files, machine],
  });
  return { plane, address: undefined, table, sessions, substrate, stopped: false };
}
async function startRuntime(fastReaper) {
  const runtime = createRuntime(fastReaper);
  runtime.address = await runtime.plane.start();
  await runtime.sessions.reconcile();
  return runtime;
}
async function stopRuntime(runtime) {
  if (!runtime || runtime.stopped) return;
  await runtime.plane.stop();
  await sleep(250);
  runtime.table.close();
  runtime.stopped = true;
}
async function runPhase(name, action) {
  const phaseStarted = Date.now();
  log(`cycle ${state.cycle} phase ${name} START`);
  await action();
  log(`cycle ${state.cycle} phase ${name} PASS (${Date.now() - phaseStarted}ms)`);
}
function transcriptPaths(directory) {
  if (!fs.existsSync(directory)) return [];
  const paths = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...transcriptPaths(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(entryPath);
  }
  return paths;
}
function writeFailureArtifacts(error) {
  const artifactDir = fs.mkdtempSync(path.join(tmpdir(), 'vibecodium-soak-failure-'));
  fs.writeFileSync(
    path.join(artifactDir, 'error.txt'),
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  fs.writeFileSync(
    path.join(artifactDir, 'events.json'),
    `${JSON.stringify(state.lastEvents, null, 2)}\n`,
  );
  const listing = spawnSync(path.resolve('.vibecodium/bin/abduco'), ['-l'], {
    encoding: 'utf8',
    env: { ...process.env, ABDUCO_SOCKET_DIR: socketDir },
  });
  fs.writeFileSync(
    path.join(artifactDir, 'abduco-l.txt'),
    `${listing.stdout ?? ''}${listing.stderr ?? ''}`,
  );
  const paths = transcriptPaths(storageRoot);
  if (paths.length === 0)
    fs.writeFileSync(path.join(artifactDir, 'transcripts.none'), 'no JSONL transcripts\n');
  paths.forEach((transcript, index) => {
    const lines = fs.readFileSync(transcript, 'utf8').split(/\r?\n/);
    fs.writeFileSync(
      path.join(artifactDir, `transcript-${index}.tail`),
      `# ${transcript}\n${lines.slice(-40).join('\n')}\n`,
    );
  });
  return artifactDir;
}
function mintEvidence(status, endedAt, error) {
  const detail =
    error === undefined ? '' : `\nerror: ${error instanceof Error ? error.stack : String(error)}`;
  return writeEvidence({
    checkName: 'soak',
    command: `${process.execPath} scripts/soak.mjs ${process.argv.slice(2).join(' ')}`.trim(),
    output: `${outputLines.join('\n')}${detail}\n`,
    exitStatus: status === 'passed' ? 0 : 1,
    startedAt,
    endedAt,
    durationMs: endedAt.getTime() - startedAtMs,
    status,
  });
}
const scenarioContext = {
  options,
  state,
  soak,
  substrateReady,
  projectDir,
  machineRoot,
  runPhase,
  openRecordedSession,
  stopRecordedSession,
  sendTurn,
  waitForEvents,
  readEvents,
  command,
  recordValue,
  readJson,
  stopRuntime,
  startRuntime,
  sleep,
  log,
};
async function main() {
  log(`provider=${options.provider} target=${Math.round(targetDuration / 1000)}s`);
  if (options.provider === 'fake' && !substrateReady)
    log('substrate-backed phases will SKIP because abduco setup failed');
  state.runtime = await startRuntime(false);
  do {
    state.cycle += 1;
    await runScenario(scenarioContext);
    const remaining = startedAtMs + targetDuration - Date.now();
    if (remaining > 0) await sleep(Math.min(options.provider === 'fake' ? 1000 : 250, remaining));
  } while (Date.now() < startedAtMs + targetDuration);
  const report = state.report;
  if (!report) throw new Error('soak completed without an invariant report');
  const endedAt = new Date();
  log(
    `PASS provider=${options.provider} cycles=${state.cycle} elapsed=${endedAt.getTime() - startedAtMs}ms events=${report.eventCount} turns=${report.turnCount} replay=${report.replayCount}`,
  );
  mintEvidence('passed', endedAt);
}
try {
  await main();
} catch (error) {
  const artifactDir = writeFailureArtifacts(error);
  process.stderr.write(
    `[soak] FAIL ${error instanceof Error ? error.message : String(error)}\n` +
      `[soak] failure artifacts: ${artifactDir}\n`,
  );
  try {
    mintEvidence('failed', new Date(), error);
  } catch (evidenceError) {
    process.stderr.write(`[soak] failed to write failure evidence: ${evidenceError}\n`);
  }
  process.exitCode = 1;
} finally {
  const runtime = state.runtime;
  if (runtime) {
    for (const name of state.substrateNames)
      await runtime.substrate.kill(name).catch(() => undefined);
  }
  await stopRuntime(runtime).catch((error) => {
    process.stderr.write(
      `[soak] cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(socketDir, { recursive: true, force: true });
}
