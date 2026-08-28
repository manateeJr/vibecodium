#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlane } from './server/control-plane.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? 'start';
  if (command !== 'start' && command !== 'dev') {
    process.stderr.write(`usage: vibecodium [start|dev]\n`);
    process.exitCode = 2;
    return;
  }
  const dataPath =
    process.env.VIBECODIUM_DB_PATH ?? path.resolve('.vibecodium/control-plane.sqlite');
  const port = Number(process.env.VIBECODIUM_PORT ?? '4310');
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error('VIBECODIUM_PORT must be 0-65535');
  const controlPlane = new ControlPlane({ dataPath, port, host: '127.0.0.1' });
  const address = await controlPlane.start();
  process.stdout.write(`Vibecodium control plane listening at ${address.httpUrl}\n`);
  const stop = (): void => {
    void controlPlane.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntryPoint)
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
