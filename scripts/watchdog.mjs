#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_HEALTHZ_TIMEOUT_MS = 2_000;
export const DEFAULT_COOLDOWN_MS = 60_000;

export function advanceWatchdog(state, poll, options = {}) {
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastRestartAt = state.lastRestartAt ?? null;
  if (poll.ok) {
    return {
      snapshot: false,
      restart: false,
      state: { consecutiveFailures: 0, lastRestartAt },
    };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  const cooldownElapsed = lastRestartAt === null || poll.timestampMs - lastRestartAt >= cooldownMs;
  if (consecutiveFailures < failureThreshold || !cooldownElapsed) {
    return {
      snapshot: false,
      restart: false,
      state: { consecutiveFailures, lastRestartAt },
    };
  }
  return {
    snapshot: true,
    restart: true,
    state: { consecutiveFailures: 0, lastRestartAt: poll.timestampMs },
  };
}

export function decideWatchdogAction(polls, options = {}) {
  let state = { consecutiveFailures: 0, lastRestartAt: null };
  let snapshot = false;
  let restart = false;
  for (const poll of polls) {
    const step = advanceWatchdog(state, poll, options);
    state = step.state;
    snapshot ||= step.snapshot;
    restart ||= step.restart;
  }
  return { snapshot, restart };
}

export const evaluateWatchdog = decideWatchdogAction;

export function watchdogConfigFromEnv(env = process.env, cwd = process.cwd()) {
  const dataPath = env.VIBECODIUM_DB_PATH ?? path.resolve(cwd, '.vibecodium/control-plane.sqlite');
  return {
    enabled: env.VIBECODIUM_WATCHDOG_ENABLED === '1' || env.VIBECODIUM_WATCHDOG_ENABLED === 'true',
    port: positiveInteger(env.VIBECODIUM_PORT, 4_310),
    dataDir: path.dirname(dataPath),
    failureThreshold: positiveInteger(env.VIBECODIUM_WATCHDOG_FAILURES, DEFAULT_FAILURE_THRESHOLD),
    pollIntervalMs: positiveInteger(env.VIBECODIUM_WATCHDOG_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    healthzTimeoutMs: positiveInteger(
      env.VIBECODIUM_WATCHDOG_TIMEOUT_MS,
      DEFAULT_HEALTHZ_TIMEOUT_MS,
    ),
    cooldownMs: positiveInteger(env.VIBECODIUM_WATCHDOG_COOLDOWN_MS, DEFAULT_COOLDOWN_MS),
  };
}

export async function pollHealthz(url, timeoutMs, fetcher = globalThis.fetch) {
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `healthz HTTP ${response.status}` };
    return { ok: true, error: undefined };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function runWatchdog(config) {
  if (!config.enabled) {
    process.stdout.write(
      'vibecodium watchdog disabled; set VIBECODIUM_WATCHDOG_ENABLED=1 to enable\n',
    );
    return;
  }
  let state = { consecutiveFailures: 0, lastRestartAt: null };
  const url = `http://127.0.0.1:${config.port}/healthz`;
  while (true) {
    const polled = await pollHealthz(url, config.healthzTimeoutMs);
    const step = advanceWatchdog(state, { ok: polled.ok, timestampMs: Date.now() }, config);
    state = step.state;
    if (step.snapshot) {
      await writeWedgeSnapshot(config, polled.error ?? 'healthz failed');
      if (step.restart) await restartService();
    }
    await sleep(config.pollIntervalMs);
  }
}

export async function writeWedgeSnapshot(config, healthzError, now = Date.now()) {
  const detectedAt = new Date(now).toISOString();
  const snapshot = {
    detectedAt,
    healthzError,
    lastHeartbeat: readHeartbeat(config.dataDir),
    os: {
      acceptQueue: await readAcceptQueue(config.port),
      rss: await readServiceRss(),
    },
  };
  const destination = path.join(config.dataDir, `wedge-${detectedAt.replaceAll(':', '-')}.json`);
  const temporary = `${destination}.tmp`;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A forensic snapshot is best effort; preserve the restart path.
    }
    process.stderr.write(`vibecodium watchdog snapshot failed: ${errorMessage(error)}\n`);
  }
}

export function parseAcceptQueue(output, port) {
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[0] !== 'LISTEN') continue;
    const localAddress = fields[3];
    const localPort = Number(
      localAddress.slice(localAddress.lastIndexOf(':') + 1).replace(']', ''),
    );
    if (localPort === port) return Number(fields[1]);
  }
  return null;
}

function readHeartbeat(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'heartbeat.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function readAcceptQueue(port) {
  try {
    const { stdout } = await execFileAsync('ss', ['-ltn', `sport = :${port}`], { timeout: 2_000 });
    return parseAcceptQueue(stdout, port);
  } catch {
    return null;
  }
}

async function readServiceRss() {
  const pid = await servicePid();
  if (pid === null) return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1_024 : null;
  } catch {
    return null;
  }
}

async function servicePid() {
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      ['--user', 'show', 'vibecodium.service', '--property=MainPID', '--value'],
      { timeout: 2_000 },
    );
    const pid = Number(stdout.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function restartService() {
  try {
    await execFileAsync('systemctl', ['--user', 'restart', 'vibecodium.service'], {
      timeout: 10_000,
    });
  } catch (error) {
    process.stderr.write(`vibecodium watchdog restart failed: ${errorMessage(error)}\n`);
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runWatchdog(watchdogConfigFromEnv()).catch((error) => {
    process.stderr.write(`vibecodium watchdog stopped: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
