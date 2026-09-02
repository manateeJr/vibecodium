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
  options: Pick<SpawnSyncOptions, 'stdio'>,
) => AttachProcess;

type OpenAndAttach = (
  client: VibecodiumClient,
  cwd: string,
  spawnProcess: AttachSpawner,
  model?: string,
  announce?: boolean,
) => Promise<void>;

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
  });
  if (isChildProcess(child)) {
    const status = waitForChild(child);
    await forceRepaintAfterAttach(client, session_id, child);
    process.exitCode = await status;
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
