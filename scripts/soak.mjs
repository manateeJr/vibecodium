#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ControlPlane } from '../dist/src/server/control-plane.js';
import { createFilesSubsystem } from '../dist/src/files/index.js';
import { SessionTable } from '../dist/src/session/session-table.js';
import { SessionSubsystem } from '../dist/src/session/index.js';
import { createSubstrateClient } from '../dist/src/substrate/index.js';
import {
  SOAK_PHASES,
  assertEventInvariants,
  assertNoStuckSessions,
  assertReplayMatchesLive,
  parseSoakArgs,
  soakDurationMs,
} from '../dist/src/soak/helpers.js';
const options = parseSoakArgs(process.argv.slice(2));
const root = mkdtempSync(path.join(tmpdir(), 'vibecodium-soak-'));
const projectDir = path.join(root, 'project');
const storageRoot = path.join(root, 'sessions');
const sharedDir = path.join(root, 'shared');
const socketDir = path.join('/tmp', `vibecodium-soak-${process.pid}`);
const databasePath = path.join(root, 'control-plane.sqlite');
const targetDuration = soakDurationMs(options);
const eventTimeoutMs = options.provider === 'fake' ? 15_000 : 180_000;
const startedAt = Date.now();
const phaseBudget = targetDuration / SOAK_PHASES.length;
const state = {
  runtime: undefined,
  sessionId: undefined,
  streamId: undefined,
  label: undefined,
  phaseIndex: 0,
  lastEvents: [],
  report: undefined,
  stopped: false,
};
const environment = new Map([
  ['VIBECODIUM_SHARED_DIR', process.env.VIBECODIUM_SHARED_DIR],
  ['VIBECODIUM_SESSION_STORAGE_ROOT', process.env.VIBECODIUM_SESSION_STORAGE_ROOT],
  ['ABDUCO_SOCKET_DIR', process.env.ABDUCO_SOCKET_DIR],
]);
mkdirSync(projectDir, { recursive: true });
mkdirSync(storageRoot, { recursive: true });
mkdirSync(socketDir, { recursive: true, mode: 0o700 });
process.env.VIBECODIUM_SHARED_DIR = sharedDir;
process.env.VIBECODIUM_SESSION_STORAGE_ROOT = storageRoot;
process.env.ABDUCO_SOCKET_DIR = socketDir;
function sleep(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
function log(message) {
  process.stdout.write(`[soak] ${message}\n`);
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
async function readEvents() {
  const runtime = state.runtime;
  if (!runtime || !state.streamId) throw new Error('cannot read events without a session');
  const url = new globalThis.URL('/events', `${runtime.address.httpUrl}/`);
  url.searchParams.set('stream_id', state.streamId);
  url.searchParams.set('from_seq', '0');
  const body = recordValue(await readJson(await globalThis.fetch(url), 'events'), 'events');
  if (!Array.isArray(body.events)) throw new Error('events response omitted events');
  state.lastEvents = body.events;
  return body.events;
}
async function waitForEvents(predicate, label) {
  const deadline = Date.now() + eventTimeoutMs;
  let events = await readEvents();
  while (Date.now() < deadline) {
    if (predicate(events)) return events;
    await sleep(options.provider === 'fake' ? 25 : 100);
    events = await readEvents();
  }
  const types = events.map((event) => event?.type ?? '?').join(',');
  throw new Error(`timed out waiting for ${label}; events=${types}`);
}
async function sendTurn(prompt) {
  const result = recordValue(
    await command('session.send', { session_id: state.sessionId, prompt }),
    'session.send',
  );
  if (typeof result.turn !== 'number') throw new Error('session.send omitted turn');
  await waitForEvents(
    (events) =>
      events.some(
        (event) => event?.type === 'turn_complete' && event.payload?.turn === result.turn,
      ),
    `turn_complete turn=${result.turn}`,
  );
  return result.turn;
}
function createRuntime(fastReaper) {
  const table = new SessionTable({ filename: databasePath });
  const substrate = createSubstrateClient({ socketDir });
  const sessions = new SessionSubsystem({
    substrate,
    sessionTable: table,
    sessionStorageRoot: storageRoot,
    idleTimeoutMs: fastReaper ? 600 : Math.max(31 * 60 * 1000, targetDuration + 60 * 1000),
    reaperIntervalMs: 100,
  });
  const files = createFilesSubsystem({ sharedDir });
  const plane = new ControlPlane({
    dataPath: databasePath,
    port: 0,
    subsystems: [sessions, files],
  });
  return { plane, address: undefined, table, sessions, substrate };
}
async function startRuntime(fastReaper) {
  const runtime = createRuntime(fastReaper);
  runtime.address = await runtime.plane.start();
  await runtime.sessions.reconcile();
  return runtime;
}
async function stopRuntime(runtime) {
  if (!runtime) return;
  await runtime.plane.stop();
  await sleep(250);
  runtime.table.close();
}
async function runPhase(name, action) {
  const index = state.phaseIndex;
  state.phaseIndex += 1;
  const wait = startedAt + phaseBudget * index - Date.now();
  if (wait > 0) await sleep(wait);
  const phaseStarted = Date.now();
  log(`phase ${name} START`);
  await action();
  log(`phase ${name} PASS (${Date.now() - phaseStarted}ms)`);
}
async function stopSession() {
  if (state.stopped) return;
  let result = await command('session.stop', { session_id: state.sessionId });
  if (result.stopped !== true && options.provider === 'omp') {
    await command('session.ensure_live', { session_id: state.sessionId });
    result = await command('session.stop', { session_id: state.sessionId });
  }
  if (result.stopped !== true) throw new Error('session.stop did not stop the soak session');
  state.stopped = true;
  await waitForEvents(
    (events) => events.some((event) => event?.type === 'session_complete'),
    'session_complete',
  );
}
async function runScenario() {
  await runPhase('open', async () => {
    const opened = recordValue(
      await command('session.open', {
        provider: options.provider,
        prompt: 'SOAK-OPEN-1: reply with this marker and do not use tools',
        cwd: projectDir,
        project: 'soak-project',
        origin: 'operator',
      }),
      'session.open',
    );
    if (typeof opened.session_id !== 'string' || typeof opened.stream_id !== 'string')
      throw new Error('session.open omitted session identifiers');
    state.sessionId = opened.session_id;
    state.streamId = opened.stream_id;
    const events = await waitForEvents(
      (items) => items.some((event) => event?.type === 'turn_complete'),
      'initial turn_complete',
    );
    const complete = events.find((event) => event?.type === 'turn_complete');
    if (!complete) throw new Error('initial turn did not complete');
  });
  await runPhase('multi-turn', async () => {
    await sendTurn('SOAK-TURN-2: reply with SOAK-TURN-2 only');
    await sendTurn('SOAK-TURN-3: reply with SOAK-TURN-3 only');
    await sendTurn('SOAK-TURN-4: reply with SOAK-TURN-4 only');
  });
  await runPhase('steering', async () => {
    if (options.provider === 'fake') {
      log('phase steering SKIP provider=fake (no persistent terminal)');
      return;
    }
    const base = recordValue(
      await command('session.send', {
        session_id: state.sessionId,
        prompt:
          'SOAK-STEERING-BASE: spend a little time reasoning about this marker before replying ' +
          'with SOAK-STEERING-BASE. '.repeat(120),
      }),
      'session.send',
    );
    if (typeof base.turn !== 'number') throw new Error('steering base turn missing');
    const keys = recordValue(
      await command('session.send_keys', { session_id: state.sessionId, keys: ['escape'] }),
      'session.send_keys',
    );
    if (keys.sent !== 1) throw new Error('steering key was not sent');
    const steering = recordValue(
      await command('session.send', {
        session_id: state.sessionId,
        prompt: 'SOAK-STEERING-INJECTED: prefer this marker in the current turn',
      }),
      'session.send',
    );
    if (steering.turn !== base.turn)
      throw new Error(`steering was not mid-turn (base=${base.turn}, injected=${steering.turn})`);
    const events = await waitForEvents(
      (items) =>
        items.some(
          (event) => event?.type === 'turn_complete' && event.payload?.turn === base.turn,
        ) &&
        items.some(
          (event) =>
            event?.type === 'session_input' &&
            event.payload?.steering === true &&
            String(event.payload?.text ?? '').includes('SOAK-STEERING-INJECTED'),
        ),
      'mid-turn steering input and completion',
    );
    if (!events.some((event) => event?.payload?.steering === true))
      throw new Error('steering input was not persisted');
  });
  await runPhase('send_keys', async () => {
    if (options.provider === 'fake') {
      log('phase send_keys SKIP provider=fake (no persistent terminal)');
      return;
    }
    const info = recordValue(
      await command('session.attach_info', { session_id: state.sessionId }),
      'session.attach_info',
    );
    if (info.state !== 'live' || typeof info.substrate_name !== 'string')
      throw new Error('attach info did not report a live substrate');
    const listed = await state.runtime.substrate.listSessions();
    if (!listed.some((session) => session.name === info.substrate_name && session.live))
      throw new Error('abduco -l did not report the live substrate');
    await state.runtime.substrate.write(
      info.substrate_name,
      new globalThis.TextEncoder().encode('SOAK-PC-TYPED-AND-CLEARED'),
    );
    await state.runtime.substrate.sendKey(info.substrate_name, 'ctrl_u');
    const keys = recordValue(
      await command('session.send_keys', { session_id: state.sessionId, keys: ['escape'] }),
      'session.send_keys',
    );
    if (keys.sent !== 1) throw new Error('warm send_keys injection was not acknowledged');
    await sendTurn('SOAK-WARM-INJECTION: reply with this marker only');
  });
  await runPhase('share-intake', async () => {
    const fileName = 'soak-shared.txt';
    const content = 'SOAK-SHARE-RIDE-ALONG\n';
    const form = new globalThis.FormData();
    form.append('file', new globalThis.Blob([content], { type: 'text/plain' }), fileName);
    form.append('note', 'SOAK-SHARE-NOTE');
    form.append('project', 'soak-project');
    const staged = recordValue(
      await readJson(
        await globalThis.fetch(`${state.runtime.address.httpUrl}/share-intake`, {
          method: 'POST',
          body: form,
        }),
        'share-intake',
      ),
      'share-intake',
    );
    if (typeof staged.token !== 'string' || !staged.token)
      throw new Error('share-intake omitted token');
    const metadata = recordValue(
      await command('files.shared_staged', { token: staged.token }),
      'files.shared_staged',
    );
    if (metadata.note !== 'SOAK-SHARE-NOTE' || metadata.project !== 'soak-project')
      throw new Error('shared note/project metadata did not round-trip');
    if (!Array.isArray(metadata.files) || metadata.files.length !== 1)
      throw new Error('share-intake did not stage exactly one file');
    const sharedFile = recordValue(metadata.files[0], 'shared file');
    if (sharedFile.name !== fileName || readFileSync(sharedFile.path, 'utf8') !== content)
      throw new Error('shared file content did not round-trip');
    const uploaded = recordValue(
      await command('files.upload', {
        session_id: state.sessionId,
        name: fileName,
        content_base64: globalThis.Buffer.from(content).toString('base64'),
        mime: 'text/plain',
      }),
      'files.upload',
    );
    if (readFileSync(uploaded.path, 'utf8') !== content)
      throw new Error('composer upload did not preserve shared file content');
    await sendTurn('SOAK-SHARE-RIDE-ALONG: continue with the staged note and file');
  });
  await runPhase('rename/recent', async () => {
    state.label = `soak-${process.pid}-${Date.now()}`;
    const renamed = recordValue(
      await command('session.rename', { session_id: state.sessionId, label: state.label }),
      'session.rename',
    );
    if (renamed.label !== state.label) throw new Error('session.rename returned the wrong label');
    const recent = recordValue(await command('session.recent', { limit: 5 }), 'session.recent');
    if (!Array.isArray(recent.sessions)) throw new Error('session.recent omitted sessions');
    const row = recent.sessions.find((session) => session.session_id === state.sessionId);
    if (!row || row.label !== state.label || row.origin !== 'operator')
      throw new Error('session.recent did not expose the renamed operator session');
  });
  await runPhase('restart', async () => {
    if (options.provider === 'fake') {
      await stopSession();
      await stopRuntime(state.runtime);
      state.runtime = await startRuntime(false);
      const listed = recordValue(await command('session.list', {}), 'session.list');
      const row = listed.sessions?.find((session) => session.session_id === state.sessionId);
      if (row?.status === 'live') throw new Error('fake session remained live after plane restart');
      log('phase restart SKIP substrate survival/reconcile provider=fake');
      return;
    }
    const substrateName = `substrate-${state.sessionId}`;
    await stopRuntime(state.runtime);
    state.runtime = await startRuntime(true);
    const events = await waitForEvents(
      (items) =>
        items.some(
          (event) =>
            event?.type === 'session_state' &&
            event.payload?.reason === 'reconciled' &&
            event.payload?.state === 'live',
        ),
      'reconciled live session state',
    );
    if (
      !events.some(
        (event) => event?.type === 'session_state' && event.payload?.reason === 'shutdown',
      )
    )
      throw new Error('restart did not persist shutdown state');
    const listed = await state.runtime.substrate.listSessions();
    if (!listed.some((session) => session.name === substrateName && session.live))
      throw new Error('substrate did not survive control-plane restart');
    await sendTurn('SOAK-RECONCILED-HISTORY: reply with this marker only');
  });
  await runPhase('reap/resume', async () => {
    if (options.provider === 'fake') {
      log('phase reap/resume SKIP provider=fake (no idle substrate)');
      return;
    }
    await waitForEvents(
      (items) =>
        items.some(
          (event) =>
            event?.type === 'session_state' &&
            event.payload?.reason === 'reaped' &&
            event.payload?.state === 'resumable',
        ),
      'idle reaper state',
    );
    const substrateName = `substrate-${state.sessionId}`;
    const listed = await state.runtime.substrate.listSessions();
    if (listed.some((session) => session.name === substrateName && session.live))
      throw new Error('idle reaper left the substrate live');
    await sendTurn('SOAK-COLD-RESUME-HISTORY: reply with this marker only');
    await waitForEvents(
      (items) =>
        items.some(
          (event) =>
            event?.type === 'session_state' &&
            event.payload?.reason === 'resumed' &&
            event.payload?.state === 'live',
        ),
      'cold resume state',
    );
    await stopSession();
  });
  await runPhase('invariants', async () => {
    await stopSession();
    const live = await readEvents();
    const replayed = await readEvents();
    assertReplayMatchesLive(live, replayed);
    const report = assertEventInvariants(live, state.streamId);
    if (report.kinds.session_started !== 1 || report.kinds.session_complete !== 1)
      throw new Error('session start/complete invariant failed');
    if (report.kinds.verify_failed !== 0)
      throw new Error('verify_failed event entered the soak stream');
    const listed = recordValue(await command('session.list', {}), 'session.list');
    assertNoStuckSessions(listed.sessions ?? []);
    state.report = report;
    log(
      `invariants kinds=${JSON.stringify(report.kinds)} turns=${report.turnCount} replay=${report.replayCount}`,
    );
  });
}
function transcriptPaths(directory) {
  if (!existsSync(directory)) return [];
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...transcriptPaths(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(entryPath);
  }
  return paths;
}
function writeFailureArtifacts(error) {
  const artifactDir = mkdtempSync(path.join(tmpdir(), 'vibecodium-soak-failure-'));
  writeFileSync(
    path.join(artifactDir, 'error.txt'),
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  writeFileSync(
    path.join(artifactDir, 'events.json'),
    `${JSON.stringify(state.lastEvents, null, 2)}\n`,
  );
  const listing = spawnSync(path.resolve('.vibecodium/bin/abduco'), ['-l'], {
    encoding: 'utf8',
    env: { ...process.env, ABDUCO_SOCKET_DIR: socketDir },
  });
  writeFileSync(
    path.join(artifactDir, 'abduco-l.txt'),
    `${listing.stdout ?? ''}${listing.stderr ?? ''}`,
  );
  const paths = transcriptPaths(storageRoot);
  if (paths.length === 0)
    writeFileSync(path.join(artifactDir, 'transcripts.none'), 'no JSONL transcripts\n');
  paths.forEach((transcript, index) => {
    const lines = readFileSync(transcript, 'utf8').split(/\r?\n/);
    writeFileSync(
      path.join(artifactDir, `transcript-${index}.tail`),
      `# ${transcript}\n${lines.slice(-40).join('\n')}\n`,
    );
  });
  return artifactDir;
}
async function main() {
  log(`provider=${options.provider} target=${Math.round(targetDuration / 1000)}s`);
  state.runtime = await startRuntime(false);
  await runScenario();
  await sleep(Math.max(0, startedAt + targetDuration - Date.now()));
  const report = state.report;
  if (!report) throw new Error('soak completed without an invariant report');
  log(
    `PASS provider=${options.provider} events=${report.eventCount} turns=${report.turnCount} replay=${report.replayCount}`,
  );
}
try {
  await main();
} catch (error) {
  const artifactDir = writeFailureArtifacts(error);
  process.stderr.write(
    `[soak] FAIL ${error instanceof Error ? error.message : String(error)}\n` +
      `[soak] failure artifacts: ${artifactDir}\n`,
  );
  process.exitCode = 1;
} finally {
  await stopRuntime(state.runtime).catch((error) => {
    process.stderr.write(
      `[soak] cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
