import { mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventKind, EventPayload } from '../contracts/events.js';
import type { SubsystemContext } from '../contracts/subsystem.js';
import type {
  HarnessPlugin,
  SubstrateAttachment,
  SubstrateClient,
  SubstrateKey,
} from '../contracts/substrate-contract.js';
import type { ProviderSession, ProviderSessionRef } from '../contracts/provider-contract.js';
import { providerByName } from '../provider/provider.js';
import {
  SessionTranscriptTailer,
  type SessionTranscriptActivity,
} from '../session/transcript-tailer.js';

export interface StartWorkerMessage {
  readonly type: 'start';
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly resumeRef?: string;
  readonly storageDir?: string;
}

export interface TurnWorkerMessage {
  readonly type: 'turn';
  readonly stream_id: string;
  readonly prompt: string;
}

export interface StopWorkerMessage {
  readonly type: 'stop';
  readonly stream_id: string;
}

export interface WorkerEventMessage {
  readonly type: 'event';
  readonly stream_id: string;
  readonly event_type: EventKind;
  readonly payload: EventPayload;
}

export interface WorkerDoneMessage {
  readonly type: 'done';

  readonly stream_id: string;
}

export interface WorkerErrorMessage {
  readonly type: 'error';
  readonly stream_id: string;
  readonly message: string;
}

export type WorkerMessage = StartWorkerMessage | TurnWorkerMessage | StopWorkerMessage;
export type WorkerOutputMessage = WorkerEventMessage | WorkerDoneMessage | WorkerErrorMessage;
export interface PersistentSessionWorkerOptions {
  readonly substrate: SubstrateClient;
  readonly plugin: HarnessPlugin;
  readonly sessionId: string;
  readonly streamId: string;
  readonly provider: string;
  readonly substrateName: string;
  readonly storageDir: string;
  readonly transcriptPath: string;
  readonly harnessRef?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly append: SubsystemContext['append'];
  readonly now?: () => number;
  readonly startAtEnd?: boolean;
  readonly initialTurn?: number;
  readonly initialOutputIndex?: number;
  readonly onActivity?: (activity: SessionTranscriptActivity) => void;
}

export interface PersistentSessionStartResult {
  readonly transcriptPath: string;
  readonly harnessRef: string;
}

export class PersistentSessionWorker {
  public readonly sessionId: string;
  public readonly streamId: string;
  public readonly provider: string;
  public readonly substrateName: string;
  public readonly storageDir: string;
  private readonly substrate: SubstrateClient;
  private readonly plugin: HarnessPlugin;
  private readonly transcriptFallback: string;
  private readonly configuredHarnessRef: string | undefined;
  private readonly cwd: string | undefined;
  private readonly model: string | undefined;
  private readonly append: SubsystemContext['append'];
  private readonly now: (() => number) | undefined;
  private readonly startAtEnd: boolean;
  private readonly initialTurn: number;
  private readonly initialOutputIndex: number;
  private readonly onActivity: ((activity: SessionTranscriptActivity) => void) | undefined;
  private attachment: SubstrateAttachment | undefined;
  private tailer: SessionTranscriptTailer | undefined;
  private started = false;
  private stopping = false;
  private busy = false;
  private nextTurn: number;
  private transcriptPath: string;
  private harnessRef: string;

  public constructor(options: PersistentSessionWorkerOptions) {
    this.substrate = options.substrate;
    this.plugin = options.plugin;
    this.sessionId = options.sessionId;
    this.streamId = options.streamId;
    this.provider = options.provider;
    this.substrateName = options.substrateName;
    this.storageDir = options.storageDir;
    this.transcriptFallback = options.transcriptPath;
    this.configuredHarnessRef = options.harnessRef;
    this.cwd = options.cwd;
    this.model = options.model;
    this.append = options.append;
    this.now = options.now;
    this.startAtEnd = options.startAtEnd ?? false;
    this.initialTurn = options.initialTurn ?? 0;
    this.initialOutputIndex = options.initialOutputIndex ?? 0;
    this.onActivity = options.onActivity;
    this.nextTurn = this.initialTurn;
    this.transcriptPath = options.transcriptPath;
    this.harnessRef = options.harnessRef ?? options.sessionId;
  }

  public get isBusy(): boolean {
    return this.busy;
  }

  public get isIdle(): boolean {
    return this.tailer?.isIdle ?? false;
  }

  public get lastActivityAt(): number {
    return this.tailer?.lastActivityAt ?? 0;
  }

  public get currentTurn(): number {
    return Math.max(this.nextTurn, this.tailer?.currentTurn ?? 0);
  }

  public get currentTranscriptPath(): string {
    return this.transcriptPath;
  }

  public get currentHarnessRef(): string {
    return this.harnessRef;
  }

  public async start(prompt?: string, resumeRef?: string): Promise<PersistentSessionStartResult> {
    if (this.started) throw new Error(`persistent session already started: ${this.sessionId}`);
    const created = await this.substrate.createSession(
      this.substrateName,
      this.plugin.launchArgv({
        sessionId: this.sessionId,
        cwd: this.cwd ?? process.cwd(),
        ...(prompt === undefined ? {} : { prompt }),
        ...(resumeRef === undefined ? {} : { resumeRef }),
        ...(this.model === undefined ? {} : { model: this.model }),
        storageDir: this.storageDir,
      }),
      this.cwd === undefined ? undefined : { cwd: this.cwd },
    );
    if (!created.live) throw new Error(`substrate session did not start: ${this.substrateName}`);
    this.busy = prompt !== undefined;
    await this.attachAndTail(false);
    return { transcriptPath: this.transcriptPath, harnessRef: this.harnessRef };
  }

  public async attachExisting(): Promise<PersistentSessionStartResult> {
    if (this.started) throw new Error(`persistent session already started: ${this.sessionId}`);
    await this.attachAndTail(true);
    return { transcriptPath: this.transcriptPath, harnessRef: this.harnessRef };
  }

  public async sendPrompt(prompt: string): Promise<number> {
    if (!this.started || this.stopping) throw new Error('persistent session is not live');
    const turn = this.busy
      ? Math.max(this.nextTurn, this.tailer?.currentTurn ?? 0)
      : Math.max(this.nextTurn, this.tailer?.currentTurn ?? 0) + 1;
    if (!this.busy) this.nextTurn = turn;
    this.busy = true;
    try {
      await this.inject(prompt);
    } catch (error) {
      this.busy = false;
      throw error;
    }
    return turn;
  }

  public async sendKeys(keys: readonly SubstrateKey[]): Promise<number> {
    if (!this.started || this.stopping) throw new Error('persistent session is not live');
    for (const key of keys) await this.substrate.sendKey(this.substrateName, key);
    return keys.length;
  }

  public async stop(): Promise<void> {
    await this.close(true);
  }

  public async shutdown(): Promise<void> {
    await this.close(false);
  }

  public async reap(): Promise<void> {
    await this.close(true);
  }

  public flushTranscript(): Promise<void> {
    return this.tailer?.readAvailable() ?? Promise.resolve();
  }

  private async attachAndTail(startAtEnd: boolean): Promise<void> {
    this.transcriptPath = await discoverTranscript(
      this.storageDir,
      this.transcriptFallback,
      this.transcriptPath,
    );
    this.harnessRef =
      this.configuredHarnessRef ?? harnessRefFromPath(this.transcriptPath, this.harnessRef);
    this.attachment = await this.substrate.attach(this.substrateName);
    this.tailer = new SessionTranscriptTailer({
      transcriptPath: this.transcriptPath,
      sessionId: this.sessionId,
      streamId: this.streamId,
      plugin: this.plugin,
      append: this.append,
      ...(this.now === undefined ? {} : { now: this.now }),
      startAtEnd: startAtEnd || this.startAtEnd,
      initialTurn: this.initialTurn,
      initialOutputIndex: this.initialOutputIndex,
      onTranscriptPath: (transcriptPath) => {
        this.transcriptPath = transcriptPath;
      },
      onActivity: (activity) => {
        this.busy = !activity.idle;
        this.onActivity?.(activity);
      },
    });
    await this.tailer.start();
    this.started = true;
  }

  private async inject(prompt: string): Promise<void> {
    for (const key of this.plugin.injectionRecipe.clearKeys) {
      await this.substrate.sendKey(this.substrateName, key);
    }
    if (prompt.length > 0) {
      await this.substrate.write(this.substrateName, new TextEncoder().encode(prompt));
    }
    for (const key of this.plugin.injectionRecipe.submitKeys) {
      await this.substrate.sendKey(this.substrateName, key);
    }
  }

  private async close(kill: boolean): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.busy = false;
    await this.tailer?.stop();
    this.tailer = undefined;
    if (kill) await this.substrate.kill(this.substrateName);
    await this.attachment?.detach();
    this.attachment = undefined;
    this.started = false;
  }
}
async function discoverTranscript(
  storageDir: string,
  fallback: string,
  preferred: string,
): Promise<string> {
  try {
    const entries = await readdir(storageDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(storageDir, entry.name))
      .sort();
    if (files.length === 0) return fallback;
    if (files.includes(preferred)) return preferred;
    return files[files.length - 1] ?? fallback;
  } catch {
    return fallback;
  }
}

function harnessRefFromPath(transcriptPath: string, fallback: string): string {
  const basename = path.basename(transcriptPath, '.jsonl');
  const match = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? fallback;
}

interface ConversationState {
  readonly session_id: string;
  readonly stream_id: string;
  readonly provider: ProviderSessionRef;
  readonly cwd?: string;
  readonly storageDir?: string;
  turn: number;
  currentSession: ProviderSession | undefined;
  stopping: boolean;
  turnChain: Promise<void>;
  stopPromise: Promise<void> | undefined;
}

function send(message: WorkerOutputMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('session worker IPC is unavailable'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function runTurn(
  state: ConversationState,
  prompt: string,
  resume: boolean,
  turn: number,
  resumeRef?: string,
): Promise<void> {
  let session: ProviderSession | undefined;
  try {
    session = await state.provider.spawn({
      sessionId: state.session_id,
      prompt,
      ...(state.cwd === undefined ? {} : { cwd: state.cwd }),
      ...(state.storageDir === undefined ? {} : { storageDir: state.storageDir }),
      resume,
      ...(resumeRef === undefined ? {} : { resumeRef }),
    });
    state.currentSession = session;
    if (state.stopping) {
      await state.provider.stop(session);
      return;
    }
    for await (const chunk of state.provider.stream(session)) {
      await send({
        type: 'event',
        stream_id: state.stream_id,
        event_type: 'session_output',
        payload: {
          session_id: state.session_id,
          index: chunk.index,
          text: chunk.text,
        },
      });
    }
    await state.provider.stop(session);
    if (state.stopping) return;
    await send({
      type: 'event',
      stream_id: state.stream_id,
      event_type: 'turn_complete',
      payload: { session_id: state.session_id, turn },
    });
  } catch (error) {
    if (session && !session.stopped) {
      try {
        await state.provider.stop(session);
      } catch {
        // Preserve the original turn failure.
      }
    }
    if (state.stopping) return;
    try {
      await send({
        type: 'error',
        stream_id: state.stream_id,
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The parent may have stopped and disconnected while the turn failed.
    }
  } finally {
    if (state.currentSession === session) state.currentSession = undefined;
  }
}

export function startSessionWorker(): void {
  let state: ConversationState | undefined;
  process.on('message', (message: WorkerMessage) => {
    if (!message) return;
    if (message.type === 'start') {
      if (state) return;
      let provider: ProviderSessionRef;
      try {
        provider = providerByName(message.provider);
      } catch (error) {
        void send({
          type: 'error',
          stream_id: message.stream_id,
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        return;
      }
      const storageDir =
        message.storageDir ??
        (message.resumeRef === undefined
          ? path.join(os.tmpdir(), 'vibecodium-sessions', message.session_id)
          : undefined);
      state = {
        session_id: message.session_id,
        stream_id: message.stream_id,
        provider,
        ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
        ...(storageDir === undefined ? {} : { storageDir }),
        turn: 1,
        stopping: false,
        turnChain: Promise.resolve(),
        currentSession: undefined,
        stopPromise: undefined,
      };
      state.turnChain = (
        storageDir === undefined ? Promise.resolve() : mkdir(storageDir, { recursive: true })
      )
        .then(() => runTurn(state!, message.prompt, false, 1, message.resumeRef))
        .catch(async (error: unknown) => {
          if (state?.stopping) return;
          try {
            await send({
              type: 'error',
              stream_id: message.stream_id,
              message: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // The parent may have stopped and disconnected while starting.
          }
        });
      return;
    }
    if (!state) return;
    if (message.type === 'turn') {
      if (state.stopping) return;
      const turn = ++state.turn;
      state.turnChain = state.turnChain.then(() => runTurn(state!, message.prompt, true, turn));
      return;
    }
    if (state.stopping || state.stopPromise) return;
    state.stopping = true;
    const currentSession = state.currentSession;
    state.stopPromise = (async () => {
      if (currentSession) {
        try {
          await state!.provider.stop(currentSession);
        } catch {
          // Stopping is best effort; the parent owns the terminal event.
        }
      }
      await state!.turnChain.catch(() => undefined);
      try {
        await send({ type: 'done', stream_id: message.stream_id });
      } catch {
        // The parent has already disconnected.
      }
      if (process.connected) process.disconnect();
    })();
  });
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntryPoint) startSessionWorker();
