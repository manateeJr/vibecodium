import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { EventKind } from '../contracts/events.js';
import type { SubsystemContext } from '../contracts/subsystem.js';
import type { HarnessPlugin, HarnessTranscriptRecord } from '../contracts/substrate-contract.js';
import {
  parseOmpTranscriptLine,
  type OmpAssistantRecord,
  type OmpSessionExitRecord,
  type OmpToolResultRecord,
} from './omp-record-parser.js';
import { contextWindowFor } from './model-context-window.js';

export interface SessionTranscriptActivity {
  readonly record: HarnessTranscriptRecord;
  readonly idle: boolean;
  readonly turn: number;
  readonly at: number;
}

export interface SessionTranscriptTailerOptions {
  readonly transcriptPath: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly plugin: HarnessPlugin;
  readonly append: SubsystemContext['append'];
  readonly now?: () => number;
  readonly startAtEnd?: boolean;
  readonly initialTurn?: number;
  readonly initialOutputIndex?: number;
  readonly onActivity?: (activity: SessionTranscriptActivity) => void;
  readonly onSessionExit?: (record: OmpSessionExitRecord) => void;
  readonly onTranscriptPath?: (transcriptPath: string) => void;
}

export class SessionTranscriptTailer {
  private activeTranscriptPath: string;
  private readonly sessionId: string;
  private readonly streamId: string;
  private readonly plugin: HarnessPlugin;
  private readonly append: SubsystemContext['append'];
  private readonly now: () => number;
  private readonly startAtEnd: boolean;
  private readonly onActivity: ((activity: SessionTranscriptActivity) => void) | undefined;
  private readonly onTranscriptPath: ((transcriptPath: string) => void) | undefined;
  private readonly onSessionExit: ((record: OmpSessionExitRecord) => void) | undefined;
  private sessionExitNotified = false;
  private decoder = new StringDecoder('utf8');
  private watcher: FSWatcher | undefined;
  private readChain: Promise<void> = Promise.resolve();
  private started = false;
  private position = 0;
  private remainder = '';
  private turn: number;
  private outputIndex: number;
  private idle = false;
  private lastActivity = 0;
  private readonly pendingTools = new Map<
    string,
    {
      readonly index: number;
      readonly name: string;
      readonly summary: string;
      readonly startedAt?: number;
    }
  >();
  private lastContextKey?: string;

  public constructor(options: SessionTranscriptTailerOptions) {
    this.activeTranscriptPath = options.transcriptPath;
    this.sessionId = options.sessionId;
    this.streamId = options.streamId;
    this.plugin = options.plugin;
    this.append = options.append;
    this.now = options.now ?? Date.now;
    this.startAtEnd = options.startAtEnd ?? false;
    this.turn = options.initialTurn ?? 0;
    this.outputIndex = options.initialOutputIndex ?? 0;
    this.onActivity = options.onActivity;
    this.onSessionExit = options.onSessionExit;
    this.onTranscriptPath = options.onTranscriptPath;
  }

  public get transcriptPath(): string {
    return this.activeTranscriptPath;
  }

  public get isIdle(): boolean {
    return this.idle;
  }

  public get lastActivityAt(): number {
    return this.lastActivity;
  }
  public get currentTurn(): number {
    return this.turn;
  }
  public async start(): Promise<void> {
    if (this.started) return;
    await mkdir(path.dirname(this.activeTranscriptPath), { recursive: true });
    await this.refreshTranscriptPath();
    if (this.startAtEnd) await this.seekToEnd();
    this.started = true;
    this.watcher = watch(path.dirname(this.activeTranscriptPath), (eventType, filename) => {
      const changedName = filename?.toString();
      if (changedName === undefined || eventType === 'rename' || changedName.endsWith('.jsonl')) {
        void this.readAvailable();
      }
    });
    await this.readAvailable();
  }

  public readAvailable(): Promise<void> {
    this.readChain = this.readChain.then(() => this.readAvailableNow()).catch(() => undefined);
    return this.readChain;
  }

  public async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    await this.readChain;
    this.started = false;
  }

  private async refreshTranscriptPath(): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.dirname(this.activeTranscriptPath), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(path.dirname(this.activeTranscriptPath), entry.name))
      .sort();
    const nextPath = files.includes(this.activeTranscriptPath)
      ? this.activeTranscriptPath
      : files.at(-1);
    if (nextPath === undefined || nextPath === this.activeTranscriptPath) return;
    this.activeTranscriptPath = nextPath;
    this.position = 0;
    this.remainder = '';
    this.decoder = new StringDecoder('utf8');
    this.onTranscriptPath?.(nextPath);
  }

  private async seekToEnd(): Promise<void> {
    try {
      const handle = await open(this.activeTranscriptPath, 'r');
      try {
        this.position = (await handle.stat()).size;
      } finally {
        await handle.close();
      }
    } catch {
      this.position = 0;
    }
  }

  private async readAvailableNow(): Promise<void> {
    if (!this.started && this.position !== 0 && !this.startAtEnd) return;
    await this.refreshTranscriptPath();
    let handle;
    try {
      handle = await open(this.activeTranscriptPath, 'r');
    } catch {
      return;
    }
    try {
      const size = (await handle.stat()).size;
      if (size < this.position) {
        this.position = 0;
        this.remainder = '';
        this.decoder = new StringDecoder('utf8');
      }
      const amount = size - this.position;
      if (amount <= 0) return;
      const buffer = Buffer.allocUnsafe(amount);
      const result = await handle.read(buffer, 0, amount, this.position);
      if (result.bytesRead <= 0) return;
      this.position += result.bytesRead;
      const text = this.decoder.write(buffer.subarray(0, result.bytesRead));
      const lines = (this.remainder + text).split('\n');
      this.remainder = lines.pop() ?? '';
      for (const line of lines) this.processLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    } finally {
      await handle.close();
    }
  }

  private processLine(line: string): void {
    const parsed = this.plugin.name === 'omp' ? parseOmpTranscriptLine(line) : null;
    const record = parsed ?? this.plugin.parseTranscriptLine(line);
    if (!record) return;
    const at = this.now();
    const wasIdle = this.idle;
    this.lastActivity = at;
    if (parsed?.kind === 'session_exit') {
      this.idle = true;
      if (!this.sessionExitNotified) {
        this.sessionExitNotified = true;
        this.onSessionExit?.(parsed);
      }
    } else if (parsed?.kind === 'tool_result') {
      this.processToolResult(parsed);
      this.idle = false;
    } else if (record.kind === 'user' || record.kind === 'steering') {
      if (record.kind === 'user') this.turn += 1;
      this.idle = false;
      this.appendEvent('session_input', {
        session_id: this.sessionId,
        turn: this.turn,
        text: record.text ?? '',
        ...(record.kind === 'steering' ? { steering: true } : {}),
      });
    } else if (record.kind === 'assistant') {
      if (parsed?.kind === 'assistant') this.appendAssistant(parsed);
      else if (record.text?.trim()) {
        this.appendOutput(record.text, 'text');
      }
      if (parsed?.kind === 'assistant' && parsed.context) {
        const { tokens, model } = parsed.context;
        const window = contextWindowFor(model);
        const contextKey = `${tokens}|${model ?? ''}|${window ?? ''}`;
        if (contextKey !== this.lastContextKey) {
          this.lastContextKey = contextKey;
          this.appendEvent('session_context', {
            session_id: this.sessionId,
            tokens,
            ...(model === undefined ? {} : { model }),
            ...(window === undefined ? {} : { context_window: window }),
          });
        }
      }
      this.idle = this.plugin.idleDetector(record);
    }
    if (!wasIdle && this.idle) {
      this.appendEvent('turn_complete', {
        session_id: this.sessionId,
        turn: this.turn,
      });
    }
    this.onActivity?.({ record, idle: this.idle, turn: this.turn, at });
  }

  private appendAssistant(record: OmpAssistantRecord): void {
    for (const text of record.thinking) {
      if (text.trim()) this.appendOutput(text, 'thinking');
    }
    for (const call of record.toolCalls) {
      const index = this.appendOutput('', 'tool', {
        name: call.name,
        summary: call.summary,
        status: 'run',
      });
      this.pendingTools.set(call.id, {
        index,
        name: call.name,
        summary: call.summary,
        ...(record.timeMs === undefined ? {} : { startedAt: record.timeMs }),
      });
    }
    if (record.text?.trim()) this.appendOutput(record.text, 'text');
  }

  private processToolResult(record: OmpToolResultRecord): void {
    const pending = this.pendingTools.get(record.toolResult.id);
    if (!pending) return;
    this.pendingTools.delete(record.toolResult.id);
    const measuredMs =
      record.toolResult.durationMs ?? durationMs(pending.startedAt, record.toolResult.timeMs);
    const ms = measuredMs === undefined ? undefined : Math.round(measuredMs);
    this.appendEvent('session_output', {
      session_id: this.sessionId,
      index: pending.index,
      text: '',
      kind: 'tool',
      tool: {
        name: pending.name,
        summary: pending.summary,
        status: record.toolResult.ok ? 'ok' : 'err',
        ...(ms === undefined ? {} : { ms }),
      },
    });
  }

  private appendOutput(
    text: string,
    kind: 'text' | 'thinking' | 'tool',
    tool?: { readonly name: string; readonly summary: string; readonly status: 'run' },
  ): number {
    const index = this.outputIndex;
    this.outputIndex += 1;
    this.appendEvent('session_output', {
      session_id: this.sessionId,
      index,
      text,
      kind,
      ...(tool === undefined ? {} : { tool }),
    });
    return index;
  }

  private appendEvent(type: EventKind, payload: Record<string, unknown>): void {
    this.append(this.streamId, type as never, payload as never);
  }
}

function durationMs(
  startedAt: number | undefined,
  endedAt: number | undefined,
): number | undefined {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return undefined;
  return Math.round(endedAt - startedAt);
}
