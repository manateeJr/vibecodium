import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type {
  ProviderCapabilityMatrix,
  ProviderChunk,
  ProviderSession,
  ProviderSessionRef,
  ProviderSpawnRequest,
} from '../contracts/provider-contract.js';

type QueueEntry = { readonly kind: 'chunk'; readonly text: string };
type QueueWaiter = (entry: QueueEntry | undefined) => void;

export type ChildProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CliProviderOptions {
  readonly command?: string;
  readonly spawn?: ChildProcessSpawner;
}

export interface CliProviderSession extends ProviderSession {
  readonly child: ChildProcess;
  readonly queue: QueueEntry[];
  readonly waiters: QueueWaiter[];
  stderr: string;
  nextIndex: number;
  decoderState: unknown;
  done: boolean;
  failure?: Error;
}

export class ProviderProcessError extends Error {
  public constructor(
    provider: string,
    code: number | null | undefined,
    signal: NodeJS.Signals | null | undefined,
    stderr: string,
  ) {
    const status = signal ? `signal ${signal}` : `exit code ${String(code)}`;
    const details = stderr.trim();
    super(`${provider} process exited with ${status}${details ? `: ${details}` : ''}`);
    this.name = 'ProviderProcessError';
  }
}

export abstract class CliProvider implements ProviderSessionRef {
  public abstract readonly name: string;

  protected readonly providerName: string;
  private readonly command: string;
  private readonly spawnProcess: ChildProcessSpawner;

  protected constructor(name: string, options: CliProviderOptions) {
    this.providerName = name;
    this.command = options.command ?? name;
    this.spawnProcess = options.spawn ?? nodeSpawn;
  }

  protected abstract commandArgs(request: ProviderSpawnRequest): string[];
  protected spawnOptions(request: ProviderSpawnRequest): SpawnOptions {
    const extra = this.extraEnv(request);
    return {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(extra === undefined ? {} : { env: { ...process.env, ...extra } }),
    };
  }

  protected extraEnv(request: ProviderSpawnRequest): NodeJS.ProcessEnv | undefined {
    void request;
    return undefined;
  }

  public abstract capabilityMatrix(): ProviderCapabilityMatrix;

  public async spawn(request: ProviderSpawnRequest): Promise<ProviderSession> {
    const child = this.spawnProcess(
      this.command,
      this.commandArgs(request),
      this.spawnOptions(request),
    );
    const session: CliProviderSession = {
      id: randomUUID(),
      request,
      stopped: false,
      child,
      queue: [],
      waiters: [],
      stderr: '',
      nextIndex: 0,
      decoderState: undefined,
      done: false,
    };
    this.initializeDecoder(session);
    this.attachProcess(session);
    return session;
  }

  public async *stream(session: ProviderSession): AsyncIterable<ProviderChunk> {
    const cliSession = this.requireSession(session);
    while (true) {
      const entry = await this.take(cliSession);
      if (!entry) {
        if (cliSession.failure) throw cliSession.failure;
        return;
      }
      if (cliSession.stopped) return;
      yield { index: cliSession.nextIndex++, text: entry.text };
    }
  }

  public async stop(session: ProviderSession): Promise<void> {
    const cliSession = this.requireSession(session);
    if (cliSession.stopped) return;
    cliSession.stopped = true;
    cliSession.queue.length = 0;
    this.finish(cliSession);
    if (
      !cliSession.child.killed &&
      (cliSession.child.exitCode === null || cliSession.child.exitCode === undefined)
    ) {
      cliSession.child.kill('SIGTERM');
    }
  }

  protected initializeDecoder(session: CliProviderSession): void {
    session.decoderState = undefined;
  }

  protected decodeStdout(
    session: CliProviderSession,
    text: string,
    flush: boolean,
  ): readonly string[] {
    void session;
    void flush;
    return text ? [text] : [];
  }

  private attachProcess(session: CliProviderSession): void {
    const stdout = session.child.stdout;
    if (!stdout) {
      session.child.kill('SIGTERM');
      throw new Error(`${this.providerName} provider did not expose stdout`);
    }
    stdout.on('data', (data: Buffer | string) => {
      try {
        for (const text of this.decodeStdout(session, data.toString(), false)) {
          this.enqueue(session, text);
        }
      } catch (error) {
        this.finish(session, asError(error));
      }
    });
    stdout.on('error', (error) => this.finish(session, asError(error)));

    session.child.stderr?.on('data', (data: Buffer | string) => {
      const remaining = 8_192 - session.stderr.length;
      if (remaining > 0) session.stderr += data.toString().slice(0, remaining);
    });
    session.child.on('error', (error) => this.finish(session, asError(error)));
    session.child.once('close', (code, signal) => {
      if (session.done) return;
      try {
        for (const text of this.decodeStdout(session, '', true)) {
          this.enqueue(session, text);
        }
      } catch (error) {
        this.finish(session, asError(error));
        return;
      }
      const failed =
        !session.stopped &&
        ((typeof code === 'number' && code !== 0) || (signal !== null && signal !== undefined));
      const failure = failed
        ? new ProviderProcessError(this.providerName, code, signal, session.stderr)
        : undefined;
      this.finish(session, failure);
    });
  }

  private requireSession(session: ProviderSession): CliProviderSession {
    const candidate = session as Partial<CliProviderSession>;
    if (
      !candidate.child ||
      !candidate.queue ||
      !candidate.waiters ||
      candidate.nextIndex === undefined
    ) {
      throw new Error(`${this.providerName} session was not created by this provider`);
    }
    return candidate as CliProviderSession;
  }

  private enqueue(session: CliProviderSession, text: string): void {
    if (!text || session.done || session.stopped) return;
    const waiter = session.waiters.shift();
    if (waiter) waiter({ kind: 'chunk', text });
    else session.queue.push({ kind: 'chunk', text });
  }

  private take(session: CliProviderSession): Promise<QueueEntry | undefined> {
    const entry = session.queue.shift();
    if (entry) return Promise.resolve(entry);
    if (session.done) return Promise.resolve(undefined);
    return new Promise((resolve) => session.waiters.push(resolve));
  }

  private finish(session: CliProviderSession, error?: Error): void {
    if (session.done) return;
    if (error) session.failure = error;
    session.done = true;
    for (const waiter of session.waiters.splice(0)) waiter(undefined);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
