import type { SessionOrigin } from './session-commands.js';
export type SubstrateSessionState = 'live' | 'resumable' | 'closed';

export type SubstrateKey = 'ctrl_u' | 'enter' | 'escape' | 'interrupt';

export interface SubstrateCreateOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
}

export interface SubstrateSessionInfo {
  readonly name: string;
  readonly live: boolean;
}

export interface SubstrateOutputChunk {
  readonly name: string;
  readonly data: Uint8Array;
}

export type SubstrateOutputListener = (chunk: SubstrateOutputChunk) => void;

export interface SubstrateAttachment {
  readonly name: string;
  detach(): Promise<void>;
}

export interface SubstrateClient {
  createSession(
    name: string,
    argv: readonly string[],
    options?: SubstrateCreateOptions,
  ): Promise<SubstrateSessionInfo>;
  /**
   * Auto-reattaching attach transparently re-establishes the attach when the
   * underlying abduco attach process exits while the session is still live.
   */
  attach(name: string): Promise<SubstrateAttachment>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  sendKey(name: string, key: SubstrateKey): Promise<void>;
  onOutput(listener: SubstrateOutputListener): () => void;
  isLive(name: string): Promise<boolean>;
  kill(name: string): Promise<void>;
  listSessions(): Promise<readonly SubstrateSessionInfo[]>;
}

export interface HarnessSessionContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly prompt?: string;
  readonly resumeRef?: string;
  readonly storageDir?: string;
  readonly model?: string;
}

export interface HarnessInjectionRecipe {
  readonly clearKeys: readonly SubstrateKey[];
  readonly submitKeys: readonly SubstrateKey[];
}

export interface HarnessTranscriptRecord {
  readonly kind: string;
  readonly raw: string;
  readonly text?: string;
  readonly ts?: string;
}

export interface HarnessPlugin {
  readonly name: string;
  launchArgv(context: HarnessSessionContext): readonly string[];
  readonly injectionRecipe: HarnessInjectionRecipe;
  idleDetector(record: HarnessTranscriptRecord): boolean;
  parseTranscriptLine(line: string): HarnessTranscriptRecord | null;
}

export interface SubstrateSessionRecord {
  readonly sessionId: string;
  readonly provider: string;
  readonly harnessRef: string;
  readonly substrateName: string;
  readonly transcriptPath: string;
  readonly storageDir: string;
  readonly state: SubstrateSessionState;
  readonly label?: string;
  readonly origin?: SessionOrigin;
  readonly updatedAt: string;
}
