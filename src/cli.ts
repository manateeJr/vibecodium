#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type VibecodiumClient } from './client/index.js';
import { ControlPlane } from './server/control-plane.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? 'start';
  if (command === 'start' || command === 'dev') {
    await startControlPlane();
    return;
  }
  const client = createClientFromEnv();
  if (command === 'session') {
    await runSessionCommand(client, args.slice(1));
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

async function runSessionCommand(client: VibecodiumClient, args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === 'open') {
    const parsed = parseSessionOpen(args);
    if (!parsed) {
      usage();
      return;
    }
    printJson(await client.openSession(parsed));
    return;
  }
  if (subcommand === 'stop' && args.length === 2) {
    printJson(await client.stopSession({ session_id: args[1]! }));
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
    'usage: vibecodium start|dev | session open --provider <p> --prompt <text> [--cwd <dir>] | session stop <id> | workflow run <template> | approve <token|stream_id>\n',
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
