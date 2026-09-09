import {
  type ChildProcess,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import type { VibecodiumClient } from './client/index.js';

export type AttachProcess = SpawnSyncReturns<Buffer> | ChildProcess;
export type AttachSpawner = (
  command: string,
  args: string[],
  options: Pick<SpawnSyncOptions, 'stdio' | 'env'>,
) => AttachProcess;

type OpenAndAttach = (
  client: VibecodiumClient,
  cwd: string,
  spawnProcess: AttachSpawner,
  model?: string,
  announce?: boolean,
) => Promise<void>;

/** Interval between attach-lease heartbeats while a terminal stays attached. */
export const ATTACH_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Structural subset of the Lane A client surface (session.attach_heartbeat /
 * session.attach_release). Declared locally so this lane compiles before Lane A
 * lands its VibecodiumClient methods; at integration the real methods satisfy
 * this shape structurally. Calls stay optional until then (no-op when absent).
 */
export interface AttachLeaseClient {
  sessionAttachHeartbeat?: (args: { session_id: string }) => Promise<{ lease_until_ms: number }>;
  sessionAttachRelease?: (args: { session_id: string }) => Promise<{ released: boolean }>;
}

/**
 * Hold the attach lease for `session_id` until the returned stop runs.
 * Heartbeats every ATTACH_HEARTBEAT_INTERVAL_MS; stop clears the interval,
 * removes the signal handlers, and best-effort releases the lease (never rejects).
 * Idempotent: only the first stop releases.
 */
function startAttachHeartbeat(client: VibecodiumClient, session_id: string): () => Promise<void> {
  // Lane A client methods pending: view the client through the local structural subset.
  const leased = client as VibecodiumClient & AttachLeaseClient;
  const beat = (): void => {
    void leased.sessionAttachHeartbeat?.({ session_id }).catch(() => undefined);
  };
  const timer = setInterval(beat, ATTACH_HEARTBEAT_INTERVAL_MS);
  // Node Timeout carries unref; keep the handle from holding the loop open.
  const unrefable: { unref?: () => void } = timer as unknown as { unref?: () => void };
  if (typeof unrefable.unref === 'function') unrefable.unref();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    await leased.sessionAttachRelease?.({ session_id }).catch(() => undefined);
  };
  // A listener suppresses Node's default terminate-on-signal, so re-raise after
  // cleanup to preserve signal-exit semantics (the child-close path also stops).
  const onSigint = (): void => {
    void stop()
      .catch(() => undefined)
      .finally(() => process.kill(process.pid, 'SIGINT'));
  };
  const onSigterm = (): void => {
    void stop()
      .catch(() => undefined)
      .finally(() => process.kill(process.pid, 'SIGTERM'));
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return stop;
}

export async function runAttachCommand(
  client: VibecodiumClient,
  args: string[],
  spawnProcess: AttachSpawner,
  openAndAttach: OpenAndAttach,
): Promise<boolean> {
  if (args.length === 0) {
    const result = await client.listSessions({});
    for (const session of result.sessions)
      process.stdout.write(`${session.session_id}\t${session.status}\n`);
    return true;
  }
  if (args[0] === '--new') {
    if (args.length > 2) return false;
    await openAndAttach(client, args[1] ?? process.cwd(), spawnProcess);
    return true;
  }
  if (args.length !== 1 || !args[0]) return false;
  await attachSession(client, args[0], spawnProcess);
  return true;
}

export async function attachSession(
  client: VibecodiumClient,
  session_id: string,
  spawnProcess: AttachSpawner,
): Promise<void> {
  const info = await client.sessionAttachInfo({ session_id });
  if (info.state === 'closed') throw new Error(`session is closed: ${session_id}`);
  const result = await client.sessionEnsureLive({ session_id });
  if (result.state === 'closed') throw new Error(`session is closed: ${session_id}`);
  process.stdout.write('detach: Ctrl+\\; double Ctrl+C exits the agent\n');
  const child = spawnProcess(info.abduco_bin_path, ['-a', result.substrate_name], {
    stdio: 'inherit',
    ...(info.socket_dir === undefined
      ? {}
      : { env: { ...process.env, ABDUCO_SOCKET_DIR: info.socket_dir } }),
  });
  if (isChildProcess(child)) {
    const stopHeartbeat = startAttachHeartbeat(client, session_id);
    try {
      const status = waitForChild(child);
      // A child 'error' racing the repaint wait must not surface as an unhandled
      // rejection; the `await status` below still rethrows it.
      void status.catch(() => undefined);
      await forceRepaintAfterAttach(client, session_id, child);
      process.exitCode = await status;
    } finally {
      await stopHeartbeat().catch(() => undefined);
    }
    return;
  }
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}

function isChildProcess(value: AttachProcess): value is ChildProcess {
  return typeof (value as ChildProcess).once === 'function';
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal === null ? 1 : 1)));
  });
}

async function forceRepaintAfterAttach(
  client: VibecodiumClient,
  session_id: string,
  child: ChildProcess,
): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  if (child.exitCode !== null || child.signalCode !== null) return;
  await client.sessionSendKeys({ session_id, keys: ['ctrl_l'] }).catch(() => undefined);
}
