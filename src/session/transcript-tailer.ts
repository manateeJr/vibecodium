import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { EventKind } from '../contracts/events.js';
import type { SubsystemContext } from '../contracts/subsystem.js';
import type { HarnessPlugin, HarnessTranscriptRecord } from '../contracts/substrate-contract.js';

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
}

export class SessionTranscriptTailer {
  public readonly transcriptPath: string;
  private readonly sessionId: string;
  private readonly streamId: string;
  private readonly plugin: HarnessPlugin;
  private readonly append: SubsystemContext['append'];
  private readonly now: () => number;
  private readonly startAtEnd: boolean;
  private readonly onActivity: ((activity: SessionTranscriptActivity) => void) | undefined;
  private readonly decoder = new StringDecoder('utf8');
  private watcher: FSWatcher | undefined;
  private readChain: Promise<void> = Promise.resolve();
  private started = false;
  private position = 0;
  private remainder = '';
  private turn: number;
  private outputIndex: number;
  private idle = false;
  private lastActivity = 0;

  public constructor(options: SessionTranscriptTailerOptions) {
    this.transcriptPath = options.transcriptPath;
    this.sessionId = options.sessionId;
    this.streamId = options.streamId;
    this.plugin = options.plugin;
    this.append = options.append;
    this.now = options.now ?? Date.now;
    this.startAtEnd = options.startAtEnd ?? false;
    this.turn = options.initialTurn ?? 0;
    this.outputIndex = options.initialOutputIndex ?? 0;
    this.onActivity = options.onActivity;
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
    await mkdir(path.dirname(this.transcriptPath), { recursive: true });
    if (this.startAtEnd) await this.seekToEnd();
    this.started = true;
    await this.readAvailable();
    this.watcher = watch(path.dirname(this.transcriptPath), (eventType, filename) => {
      const changedName = filename?.toString();
      if (
        changedName === undefined ||
        changedName === path.basename(this.transcriptPath) ||
        eventType === 'rename'
      ) {
        void this.readAvailable();
      }
    });
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

  private async seekToEnd(): Promise<void> {
    try {
      const handle = await open(this.transcriptPath, 'r');
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
    let handle;
    try {
      handle = await open(this.transcriptPath, 'r');
    } catch {
      return;
    }
    try {
      const size = (await handle.stat()).size;
      if (size < this.position) {
        this.position = 0;
        this.remainder = '';
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
    const record = this.plugin.parseTranscriptLine(line);
    if (!record) return;
    const at = this.now();
    this.lastActivity = at;
    if (record.kind === 'user' || record.kind === 'steering') {
      if (record.kind === 'user') this.turn += 1;
      this.idle = false;
      this.appendEvent('session_input', {
        session_id: this.sessionId,
        turn: this.turn,
        text: record.text ?? '',
        ...(record.kind === 'steering' ? { steering: true } : {}),
      });
    } else if (record.kind === 'assistant') {
      this.appendEvent('session_output', {
        session_id: this.sessionId,
        index: this.outputIndex,
        text: record.text ?? '',
      });
      this.outputIndex += 1;
      this.idle = this.plugin.idleDetector(record);
      if (this.idle) {
        this.appendEvent('turn_complete', {
          session_id: this.sessionId,
          turn: this.turn,
        });
      }
    }
    this.onActivity?.({ record, idle: this.idle, turn: this.turn, at });
  }

  private appendEvent(type: EventKind, payload: Record<string, unknown>): void {
    this.append(this.streamId, type as never, payload as never);
  }
}
