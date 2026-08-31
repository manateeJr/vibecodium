#!/usr/bin/env node
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type ProjectSaveArgs, type VibecodiumClient } from './client/index.js';
import { ControlPlane } from './server/control-plane.js';
import { runListCommand } from './cli-list.js';

export type AttachProcess = SpawnSyncReturns<Buffer> | ChildProcess;
export type AttachSpawner = (
  command: string,
  args: string[],
  options: Pick<SpawnSyncOptions, 'stdio'>,
) => AttachProcess;

export interface CliDependencies {
  readonly client?: VibecodiumClient;
  readonly spawn?: AttachSpawner;
}

export async function main(
  args = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<void> {
  const command = args[0] ?? 'start';
  if (command === 'start' || command === 'dev') {
    await startControlPlane();
    return;
  }
  if (command === 'soak') {
    const soakScript = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'scripts',
      'soak.mjs',
    );
    const result = spawnSync(process.execPath, [soakScript, ...args.slice(1)], {
      stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
    return;
  }
  const client = dependencies.client ?? createClientFromEnv();
  const spawnProcess =
    dependencies.spawn ??
    ((command: string, spawnArgs: string[], options: Pick<SpawnSyncOptions, 'stdio'>) =>
      spawn(command, spawnArgs, { stdio: options.stdio }));

  if (command === 'list') {
    await runListCommand(client, args.slice(1));
    return;
  }
  if (command === 'attach') {
    await runAttachCommand(client, args.slice(1), spawnProcess);
    return;
  }
  if (command === 'open') {
    await runOpenCommand(client, args.slice(1), spawnProcess);
    return;
  }
  if (command === 'project') {
    await runProjectCommand(client, args.slice(1));
    return;
  }
  if (command === 'machine') {
    await runMachineCommand(client, args.slice(1));
    return;
  }
  if (command === 'session') {
    await runSessionCommand(client, args.slice(1));
    return;
  }
  if (command === 'workspace') {
    await runWorkspaceCommand(client, args.slice(1));
    return;
  }
  if (command === 'workflow') {
    await runWorkflowCommand(client, args.slice(1));
    return;
  }
  if (command === 'approve') {
    await runApproveCommand(client, args.slice(1));
    return;
  }
  usage();
}

async function startControlPlane(): Promise<void> {
  const dataPath =
    process.env.VIBECODIUM_DB_PATH ?? path.resolve('.vibecodium/control-plane.sqlite');
  const port = configuredPort();
  const controlPlane = new ControlPlane({ dataPath, port, host: '127.0.0.1' });
  const address = await controlPlane.start();
  process.stdout.write(`Vibecodium control plane listening at ${address.httpUrl}\n`);
  const stop = (): void => {
    void controlPlane.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function createClientFromEnv(): VibecodiumClient {
  const baseUrl = process.env.VIBECODIUM_URL ?? `http://127.0.0.1:${configuredPort()}`;
  const token = process.env.VIBECODIUM_TOKEN;
  return createClient({ baseUrl, ...(token === undefined ? {} : { token }) });
}
async function runAttachCommand(
  client: VibecodiumClient,
  args: string[],
  spawnProcess: AttachSpawner,
): Promise<void> {
  if (args.length === 0) {
    const result = await client.listSessions({});
    for (const session of result.sessions)
      process.stdout.write(`${session.session_id}\t${session.status}\n`);
    return;
  }
  if (args[0] === '--new') {
    if (args.length > 2) {
      usage();
      return;
    }
    await openAndAttach(client, args[1] ?? process.cwd(), spawnProcess);
    return;
  }
  if (args.length !== 1 || !args[0]) {
    usage();
    return;
  }
  await attachSession(client, args[0], spawnProcess);
}

async function runOpenCommand(
  client: VibecodiumClient,
  args: string[],
  spawnProcess: AttachSpawner,
): Promise<void> {
  if (args.length !== 1 || !args[0]) {
    usage();
    return;
  }
  await openAndAttach(client, args[0], spawnProcess);
}

async function openAndAttach(
  client: VibecodiumClient,
  cwd: string,
  spawnProcess: AttachSpawner,
): Promise<void> {
  const result = await client.openSession({
    provider: 'omp',
    prompt: '',
    cwd,
    origin: 'operator',
    source: 'cli',
  });
  await attachSession(client, result.session_id, spawnProcess);
}

async function attachSession(
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

async function runMachineCommand(client: VibecodiumClient, args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== 'list') {
    usage();
    return;
  }
  const result = await client.machineList();
  for (const session of result.sessions)
    process.stdout.write(`${session.source}\t${session.ref}\t${session.title}\t${session.cwd}\n`);
}

async function runSessionCommand(client: VibecodiumClient, args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === 'open') {
    const parsed = parseSessionOpen(args);
    if (!parsed) {
      usage();
      return;
    }
    printJson(await client.openSession({ ...parsed, source: 'cli' }));
    return;
  }
  if (subcommand === 'resume' && args.length >= 4) {
    const source = args[1];
    const ref = args[2];
    const prompt = args.slice(3).join(' ').trim();
    if ((source !== 'omp' && source !== 'codex') || !ref || !prompt) {
      usage();
      return;
    }
    printJson(await client.resumeSession({ source, ref, prompt, origin: 'operator' }));
    return;
  }
  if (subcommand === 'send' && args.length >= 3) {
    const session_id = args[1]!;
    const prompt = args.slice(2).join(' ').trim();
    if (!prompt) {
      usage();
      return;
    }
    printJson(await client.sendMessage({ session_id, prompt }));
    return;
  }
  if (subcommand === 'stop' && args.length === 2) {
    printJson(await client.stopSession({ session_id: args[1]! }));
    return;
  }
  usage();
}

async function runProjectCommand(client: VibecodiumClient, args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === 'list') {
    const result = await client.listProjects();
    for (const project of result.projects)
      process.stdout.write(`${project.name}\t${project.path}\t${project.description}\n`);
    return;
  }
  if (args.length === 2 && args[0] === 'detect' && args[1]) {
    printJson(await client.detectProject({ path: args[1] }));
    return;
  }
  if (args.length === 2 && args[0] === 'save' && args[1]) {
    let parsed: ProjectSaveArgs;
    try {
      parsed = JSON.parse(args[1]) as ProjectSaveArgs;
    } catch {
      usage();
      return;
    }
    printJson(await client.saveProject(parsed));
    return;
  }
  if (args.length === 2 && args[0] === 'remove' && args[1]) {
    printJson(await client.removeProject({ name: args[1] }));
    return;
  }
  usage();
}

async function runWorkspaceCommand(client: VibecodiumClient, args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === 'list') {
    const result = await client.listWorkspaces();
    for (const workspace of result.workspaces)
      process.stdout.write(`${workspace.name}\t${workspace.path}\n`);
    return;
  }
  if (args.length === 2 && args[0] === 'status' && args[1]) {
    printJson(await client.workspaceStatus({ path: args[1] }));
    return;
  }
  usage();
}

async function runWorkflowCommand(client: VibecodiumClient, args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== 'run') {
    usage();
    return;
  }
  printJson(await client.runWorkflow({ template: args[1]! }));
}

async function runApproveCommand(client: VibecodiumClient, args: string[]): Promise<void> {
  if (args.length !== 1 || !args[0]) {
    usage();
    return;
  }
  const target = args[0];
  printJson(
    target.startsWith('workflow:')
      ? await client.approve({ stream_id: target })
      : await client.approve({ token: target }),
  );
}

function parseSessionOpen(
  args: string[],
): { provider: string; prompt: string; cwd?: string } | undefined {
  if (args[0] !== 'open' || args.length < 5 || args.length % 2 === 0) return undefined;
  let provider: string | undefined;
  let prompt: string | undefined;
  let cwd: string | undefined;
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value || (name !== '--provider' && name !== '--prompt' && name !== '--cwd'))
      return undefined;
    if (name === '--provider') {
      if (provider !== undefined) return undefined;
      provider = value;
    } else if (name === '--prompt') {
      if (prompt !== undefined) return undefined;
      prompt = value;
    } else {
      if (cwd !== undefined) return undefined;
      cwd = value;
    }
  }
  if (!provider || prompt === undefined) return undefined;
  return { provider, prompt, ...(cwd === undefined ? {} : { cwd }) };
}

function configuredPort(): number {
  const port = Number(process.env.VIBECODIUM_PORT ?? '4310');
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error('VIBECODIUM_PORT must be 0-65535');
  return port;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function usage(): void {
  process.stderr.write(
    [
      'usage: vibecodium <command>',
      '',
      '  start | dev                       run the control plane (dev: local checkout)',
      '  list [--project <p>] [--query <q>] [--all] [--json]',
      '                                    find sessions (interactive project + keyword picker)',
      '  attach                            list attachable sessions',
      '  attach <session-id>               ensure-live, then attach this terminal to the session TUI (detach: Ctrl+\\)',
      '  attach --new [cwd]                open a fresh omp session and attach',
      '  open <cwd>                        open a fresh omp session in <cwd> and attach',
      '  project list                      registered projects',
      '  project detect <path>             detect project settings for a path',
      '  project save <json>               save a project (JSON args)',
      '  project remove <name>             remove a project',
      '  machine list                      discovered on-machine agent sessions (omp/codex stores)',
      '  session open --provider <p> --prompt <text> [--cwd <dir>]',
      '  session resume <omp|codex> <ref> <prompt...>',
      '  session send <id> <prompt...>     send into a session (steers a running turn)',
      '  session stop <id>                 stop a session',
      '  workspace list | workspace status <path>',
      '  workflow run <template>',
      '  soak [--provider fake] [--minutes N]',
      '                                    run the replayable end-to-end soak scenario (default 30 min, real omp)',
      '  approve <token|stream_id>         approve a pending action',
      '',
    ].join('\n'),
  );
  process.exitCode = 2;
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntryPoint)
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
