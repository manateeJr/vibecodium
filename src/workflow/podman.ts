import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';

export interface PodmanRunRequest {
  readonly image: string;
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface PodmanRunResult {
  readonly ok: boolean;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly error_code?: string;
}

export type PodmanRunner = (request: PodmanRunRequest) => PodmanRunResult;

export type PodmanInvoker = (
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

/**
 * Run a verification command in a rootless Podman container with networking
 * disabled. The invoker is injectable so tests never need a local Podman daemon.
 */
export function runPodmanRootless(
  request: PodmanRunRequest,
  invoke: PodmanInvoker = spawnSync,
): PodmanRunResult {
  if (!request.image.trim()) throw new Error('sandbox image is required');
  if (request.command.length === 0) throw new Error('sandbox command is required');

  const args = [
    'run',
    '--network=none',
    '--rm',
    '--userns=keep-id',
    request.image,
    ...request.command,
  ];
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    stdio: 'pipe',
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
  };

  try {
    const result = invoke('podman', args, options);
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const processError = result.error;
    const errorText =
      processError?.message ?? (result.signal ? `terminated by ${result.signal}` : undefined);
    const errorCode =
      processError && 'code' in processError && typeof processError.code === 'string'
        ? processError.code
        : undefined;
    return {
      ok: !processError && result.status === 0,
      exit_code: result.status,
      stdout,
      stderr,
      ...(errorText ? { error: errorText } : {}),
      ...(errorCode ? { error_code: errorCode } : {}),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      exit_code: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : String(error),
      ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? { error_code: error.code }
        : {}),
    };
  }
}

export const runPodmanVerify = runPodmanRootless;
