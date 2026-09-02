import type { VibecodiumClient } from './client/index.js';
import { attachSession, type AttachSpawner } from './cli-attach.js';

export async function runOmpCommand(
  client: VibecodiumClient,
  args: string[],
  spawnProcess: AttachSpawner,
): Promise<boolean> {
  let cwd = process.cwd();
  let model: string | undefined;
  let cwdProvided = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--model' && flag !== '--cwd') return false;
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) return false;
    if (flag === '--model') {
      if (model !== undefined) return false;
      model = value;
    } else {
      if (cwdProvided) return false;
      cwd = value;
      cwdProvided = true;
    }
    index += 1;
  }
  await openAndAttach(client, cwd, spawnProcess, model, true);
  return true;
}

export async function runOpenCommand(
  client: VibecodiumClient,
  args: string[],
  spawnProcess: AttachSpawner,
): Promise<boolean> {
  if (args[0] === '--attach') {
    if (args.length > 2 || (args[1] !== undefined && args[1].startsWith('--'))) return false;
    await openAndAttach(client, args[1] ?? process.cwd(), spawnProcess, undefined, true);
    return true;
  }
  if (args.length !== 1 || !args[0]) return false;
  await openAndAttach(client, args[0], spawnProcess);
  return true;
}

export async function openAndAttach(
  client: VibecodiumClient,
  cwd: string,
  spawnProcess: AttachSpawner,
  model?: string,
  announce = false,
): Promise<void> {
  const result = await client.openSession({
    provider: 'omp',
    cwd,
    origin: 'operator',
    source: 'cli',
    ...(model === undefined ? {} : { model }),
  });
  if (announce)
    process.stderr.write(
      `session ${result.session_id} — reattach with: vibecodium attach ${result.session_id}\n`,
    );
  await attachSession(client, result.session_id, spawnProcess);
}
