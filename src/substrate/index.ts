import { spawnSync } from 'node:child_process';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateCreateOptions,
  SubstrateKey,
  SubstrateOutputListener,
  SubstrateSessionInfo,
} from '../contracts/substrate-contract.js';
import { openAttachment, type AttachmentConnection, type AttachmentEvents } from './connection.js';
import { encodeResize, MAX_PAYLOAD_BYTES, MESSAGE_TYPES } from './protocol.js';
import {
  abducoBinaryPath,
  socketPathCandidates,
  validateSessionName,
  type SocketPathOptions,
} from './paths.js';

import { stopSubstrateScope } from './session-scope.js';
export interface AbducoSubstrateClientOptions {
  readonly binaryPath?: string;
  readonly abducoPath?: string;
  readonly socketDir?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly reattachMinDelayMs?: number;
  readonly reattachMaxDelayMs?: number;
  readonly operationTimeoutMs?: number;
}

interface AttachmentState {
  readonly name: string;
  connection: AttachmentConnection | undefined;
  reconnectTask: Promise<AttachmentConnection> | undefined;
  references: number;
  stopped: boolean;
  exited: boolean;
}

const KEY_BYTES: Record<SubstrateKey, Uint8Array> = {
  ctrl_u: Uint8Array.of(0x15),
  enter: Uint8Array.of(0x0d),
  escape: Uint8Array.of(0x1b),
  interrupt: Uint8Array.of(0x03),
  ctrl_l: Uint8Array.of(0x0c),
};

const DEFAULT_REATTACH_MIN_DELAY_MS = 25;
const DEFAULT_REATTACH_MAX_DELAY_MS = 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5000;
const SYSTEMD_RUN_COMMAND = 'systemd-run';
const MEMORY_MAX_PATTERN = /^(?:infinity|\d+(?:\.\d+)?(?:[KMGTPE](?:i?B?)?|%)?)$/i;

let systemdRunAvailability: boolean | undefined;
let fallbackWarningEmitted = false;

export interface SubstrateLaunchCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

function normalizeMemoryMax(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && MEMORY_MAX_PATTERN.test(normalized) ? normalized : undefined;
}

export function buildSubstrateLaunch(
  systemdRunAvailable: boolean,
  abducoPath: string,
  sessionName: string,
  argv: readonly string[],
  memoryMax?: string,
): SubstrateLaunchCommand {
  const abducoArgs = ['-n', sessionName, ...argv];
  if (!systemdRunAvailable) return { executable: abducoPath, args: abducoArgs };
  const scopedArgs = [
    '--user',
    '--scope',
    '--collect',
    '--quiet',
    `--unit=vibecodium-session-${sessionName}.scope`,
  ];
  const normalizedMemoryMax = normalizeMemoryMax(memoryMax);
  if (normalizedMemoryMax !== undefined) scopedArgs.push('-p', `MemoryMax=${normalizedMemoryMax}`);
  return {
    executable: SYSTEMD_RUN_COMMAND,
    args: [...scopedArgs, '--', abducoPath, ...abducoArgs],
  };
}

export function detectSystemdRun(): boolean {
  if (systemdRunAvailability !== undefined) return systemdRunAvailability;
  try {
    const result = spawnSync(SYSTEMD_RUN_COMMAND, ['--version'], { stdio: 'ignore' });
    systemdRunAvailability = !result.error && result.status === 0;
  } catch {
    systemdRunAvailability = false;
  }
  return systemdRunAvailability;
}

function warnSystemdRunFallback(): void {
  if (fallbackWarningEmitted) return;
  fallbackWarningEmitted = true;
  console.warn(
    '[substrate] systemd-run is unavailable; falling back to direct abduco spawning. ' +
      'Sessions stay in the service cgroup and will not survive a service restart; ' +
      'install systemd-run to enable per-session transient scopes.',
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
export function parseSessionListing(output: string): readonly SubstrateSessionInfo[] {
  const sessions: SubstrateSessionInfo[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.length === 0 || rawLine.startsWith('Active sessions')) continue;
    const fields = rawLine.split('\t');
    const name = fields.at(-1)?.trim();
    if (!name || fields.length < 4) continue;
    const pid = Number(fields.at(-2));
    sessions.push({
      name,
      live: rawLine[0] !== '+',
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    });
  }
  return sessions;
}
export class AbducoSubstrateClient implements SubstrateClient {
  private readonly binaryPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly socketOptions: SocketPathOptions;
  private readonly reattachMinDelayMs: number;
  private readonly reattachMaxDelayMs: number;
  private readonly operationTimeoutMs: number;
  private readonly attachments = new Map<string, AttachmentState>();
  private readonly listeners = new Set<SubstrateOutputListener>();
  public constructor(options: AbducoSubstrateClientOptions = {}) {
    this.binaryPath = options.binaryPath ?? options.abducoPath ?? abducoBinaryPath();
    this.environment = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {})) this.environment[key] = value;
    if (options.socketDir !== undefined) this.environment.ABDUCO_SOCKET_DIR = options.socketDir;
    const socketDir = options.socketDir ?? this.environment.ABDUCO_SOCKET_DIR;
    this.socketOptions =
      socketDir === undefined
        ? { environment: this.environment }
        : { socketDir, environment: this.environment };
    this.reattachMinDelayMs = options.reattachMinDelayMs ?? DEFAULT_REATTACH_MIN_DELAY_MS;
    this.reattachMaxDelayMs = options.reattachMaxDelayMs ?? DEFAULT_REATTACH_MAX_DELAY_MS;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (this.reattachMinDelayMs <= 0 || this.reattachMaxDelayMs < this.reattachMinDelayMs)
      throw new RangeError('abduco reattach delays must be positive and ordered');
    if (this.operationTimeoutMs <= 0)
      throw new RangeError('abduco operation timeout must be positive');
  }
  public async createSession(
    name: string,
    argv: readonly string[],
    options: SubstrateCreateOptions = {},
  ): Promise<SubstrateSessionInfo> {
    validateSessionName(name);
    if (argv.length === 0) throw new Error('abduco sessions require a non-empty argv');
    if (await this.isLive(name)) throw new Error(`abduco session already exists: ${name}`);

    const environment = { ...this.environment };
    for (const [key, value] of Object.entries(options.env ?? {})) environment[key] = value;
    if (this.socketOptions.socketDir !== undefined)
      environment.ABDUCO_SOCKET_DIR = this.socketOptions.socketDir;
    const useSystemdRun = detectSystemdRun();
    if (!useSystemdRun) warnSystemdRunFallback();
    const launch = buildSubstrateLaunch(
      useSystemdRun,
      this.binaryPath,
      name,
      argv,
      environment.VIBECODIUM_SESSION_MEMORY_MAX,
    );
    const result = spawnSync(launch.executable, launch.args, {
      cwd: options.cwd,
      env: environment,
      stdio: 'ignore',
    });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `abduco binary not found at ${this.binaryPath}. Run npm run setup:substrate first.`,
        );
      throw new Error(`could not start abduco at ${this.binaryPath}: ${result.error.message}`);
    }
    if (result.status !== 0)
      throw new Error(
        `abduco failed to create session ${name} (exit ${result.status ?? 'unknown'})`,
      );
    await this.waitForLive(name);
    if (options.cols !== undefined || options.rows !== undefined)
      await this.resize(name, options.rows ?? 25, options.cols ?? 80);
    return { name, live: true };
  }

  public async attach(name: string): Promise<SubstrateAttachment> {
    validateSessionName(name);
    const existing = this.attachments.get(name);
    if (existing) {
      existing.references += 1;
      try {
        await this.connectionFor(existing);
      } catch (error) {
        existing.references -= 1;
        throw error;
      }
      return this.attachmentHandle(existing);
    }

    const state: AttachmentState = {
      name,
      connection: undefined,
      reconnectTask: undefined,
      references: 1,
      stopped: false,
      exited: false,
    };
    this.attachments.set(name, state);
    try {
      state.connection = await this.openSessionConnection(name, this.stateEvents(state));
      return this.attachmentHandle(state);
    } catch (error) {
      state.stopped = true;
      this.attachments.delete(name);
      throw new Error(
        `could not attach to abduco session ${name}: ${errorFromUnknown(error).message}`,
      );
    }
  }

  public async write(name: string, bytes: Uint8Array): Promise<void> {
    validateSessionName(name);
    if (bytes.length === 0) return;
    const state = this.attachments.get(name);
    if (state) {
      await this.writeChunks(await this.connectionFor(state), bytes, state);
      return;
    }

    const connection = await this.openSessionConnection(name, {
      onContent: (data) => this.emitOutput(name, data),
    });
    try {
      await this.writeChunks(connection, bytes);
    } finally {
      await connection.close();
    }
  }

  public async sendKey(name: string, key: SubstrateKey): Promise<void> {
    await this.write(name, KEY_BYTES[key]);
  }

  public onOutput(listener: SubstrateOutputListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async isLive(name: string): Promise<boolean> {
    validateSessionName(name);
    try {
      const connection = await this.openSessionConnection(name, {});
      await connection.close();
      return true;
    } catch {
      return false;
    }
  }

  public async kill(name: string): Promise<void> {
    validateSessionName(name);
    const systemdRunAvailable = detectSystemdRun();
    const state = this.attachments.get(name);
    const activeConnection = state?.connection;
    if (state) {
      state.stopped = true;
      state.exited = true;
      this.attachments.delete(name);
      state.connection = undefined;
    }
    stopSubstrateScope(name, systemdRunAvailable, this.operationTimeoutMs);
    if (activeConnection) {
      await activeConnection.send(MESSAGE_TYPES.exit).catch(() => undefined);
      activeConnection.destroy();
    }

    const deadline = Date.now() + this.operationTimeoutMs;
    while (await this.isLive(name)) {
      try {
        const connection = await this.openSessionConnection(name, {});
        try {
          await connection.send(MESSAGE_TYPES.exit);
        } finally {
          await connection.close(false);
        }
      } catch {
        // A server can briefly close and recreate its listener while exiting.
      }
      if (Date.now() >= deadline)
        throw new Error(
          `abduco session did not terminate within ${this.operationTimeoutMs}ms: ${name}`,
        );
      await sleep(this.reattachMinDelayMs);
    }
    stopSubstrateScope(name, systemdRunAvailable, this.operationTimeoutMs);
  }

  public async listSessions(): Promise<readonly SubstrateSessionInfo[]> {
    const result = spawnSync(this.binaryPath, ['-l'], {
      env: this.environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `abduco binary not found at ${this.binaryPath}. Run npm run setup:substrate first.`,
        );
      throw new Error(`could not list abduco sessions: ${result.error.message}`);
    }
    if (result.status !== 0)
      throw new Error(`abduco -l failed (exit ${result.status ?? 'unknown'})`);
    return parseSessionListing(result.stdout);
  }

  private stateEvents(state: AttachmentState): AttachmentEvents {
    return {
      onContent: (data) => this.emitOutput(state.name, data),
      onExit: () => {
        state.exited = true;
      },
      onClose: () => {
        state.connection = undefined;
        if (!state.stopped && !state.exited) void this.connectionFor(state).catch(() => undefined);
      },
    };
  }

  private async openSessionConnection(
    name: string,
    events: AttachmentEvents,
  ): Promise<AttachmentConnection> {
    let lastError: Error | undefined;
    for (const socketPath of socketPathCandidates(name, this.socketOptions)) {
      try {
        return await openAttachment(socketPath, events);
      } catch (error) {
        lastError = errorFromUnknown(error);
      }
    }
    throw lastError ?? new Error(`abduco socket not found for session ${name}`);
  }

  private connectionFor(state: AttachmentState): Promise<AttachmentConnection> {
    if (state.connection) return Promise.resolve(state.connection);
    if (state.stopped || state.exited)
      return Promise.reject(new Error(`abduco session is closed: ${state.name}`));
    if (state.reconnectTask) return state.reconnectTask;
    const task = this.reconnect(state).then((connection) => {
      if (!connection) throw new Error(`abduco session is no longer live: ${state.name}`);
      return connection;
    });
    state.reconnectTask = task.finally(() => {
      state.reconnectTask = undefined;
    });
    return state.reconnectTask;
  }

  private async reconnect(state: AttachmentState): Promise<AttachmentConnection | undefined> {
    let delay = this.reattachMinDelayMs;
    while (!state.stopped && !state.exited) {
      try {
        const connection = await this.openSessionConnection(state.name, this.stateEvents(state));
        if (state.stopped || state.exited) {
          await connection.close();
          return undefined;
        }
        state.connection = connection;
        return connection;
      } catch {
        if (state.stopped || state.exited) return undefined;
        if (!(await this.isLive(state.name))) {
          state.exited = true;
          return undefined;
        }
        await sleep(delay);
        delay = Math.min(this.reattachMaxDelayMs, delay * 2);
      }
    }
    return undefined;
  }

  private attachmentHandle(state: AttachmentState): SubstrateAttachment {
    let detached = false;
    return {
      name: state.name,
      detach: async () => {
        if (detached) return;
        detached = true;
        state.references -= 1;
        if (state.references > 0) return;
        state.stopped = true;
        this.attachments.delete(state.name);
        const connection = state.connection;
        state.connection = undefined;
        if (connection) await connection.close();
      },
    };
  }

  private async writeChunks(
    initialConnection: AttachmentConnection,
    bytes: Uint8Array,
    state?: AttachmentState,
  ): Promise<void> {
    let connection = initialConnection;
    for (let offset = 0; offset < bytes.length;) {
      const chunk = bytes.subarray(offset, Math.min(offset + MAX_PAYLOAD_BYTES, bytes.length));
      try {
        await connection.send(MESSAGE_TYPES.content, chunk);
        offset += chunk.length;
      } catch (error) {
        if (!state || state.stopped || state.exited) throw error;
        if (state.connection === connection) {
          state.connection = undefined;
          connection.destroy();
        }
        connection = await this.connectionFor(state);
      }
    }
  }

  private async resize(name: string, rows: number, cols: number): Promise<void> {
    const connection = await this.openSessionConnection(name, {});
    try {
      await connection.send(MESSAGE_TYPES.resize, encodeResize(rows, cols));
    } finally {
      await connection.close();
    }
  }

  private async waitForLive(name: string): Promise<void> {
    const deadline = Date.now() + this.operationTimeoutMs;
    while (!(await this.isLive(name))) {
      if (Date.now() >= deadline)
        throw new Error(
          `abduco session did not become live within ${this.operationTimeoutMs}ms: ${name}`,
        );
      await sleep(this.reattachMinDelayMs);
    }
  }

  private emitOutput(name: string, data: Uint8Array): void {
    const chunk = Uint8Array.from(data);
    for (const listener of this.listeners) {
      try {
        listener({ name, data: chunk });
      } catch {
        // One subscriber must not stop fan-out to the remaining listeners.
      }
    }
  }
}

export const SubstrateClientImpl = AbducoSubstrateClient;
export const AbducoClient = AbducoSubstrateClient;
export function createSubstrateClient(options: AbducoSubstrateClientOptions = {}): SubstrateClient {
  return new AbducoSubstrateClient(options);
}

export type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateCreateOptions,
  SubstrateKey,
  SubstrateOutputChunk,
  SubstrateOutputListener,
  SubstrateSessionInfo,
} from '../contracts/substrate-contract.js';

export {
  decodeUint32,
  decodeUint64,
  encodeFrame,
  encodeResize,
  encodeUint32,
  FrameDecoder,
  MAX_PAYLOAD_BYTES,
  MESSAGE_TYPES,
} from './protocol.js';
