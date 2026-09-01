import { spawn, type ChildProcess } from 'node:child_process';

interface ListProcessResult {
  readonly stdout: string;
  readonly error?: unknown;
  readonly status?: number | null;
}

export async function listAbducoSessions(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await new Promise<ListProcessResult>((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value: ListProcessResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, ['-l'], {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      finish({ stdout, error });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.resume();
    child.stdout?.on('data', (chunk: string | Buffer) => {
      stdout += chunk.toString();
    });
    child.once('error', (error: unknown) => finish({ stdout, error }));
    child.once('close', (status: number | null) => finish({ stdout, status }));
  });
  if (result.error !== undefined) {
    const error = result.error instanceof Error ? result.error : new Error(String(result.error));
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        `abduco binary not found at ${binaryPath}. Run npm run setup:substrate first.`,
      );
    throw new Error(`could not list abduco sessions: ${error.message}`);
  }
  if (result.status !== 0) throw new Error(`abduco -l failed (exit ${result.status ?? 'unknown'})`);
  return result.stdout;
}
