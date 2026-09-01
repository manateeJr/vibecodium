import { readFile, stat } from 'node:fs/promises';
import type {
  SubstrateClient,
  SubstrateCreateOptions,
  SubstrateSessionInfo,
} from '../contracts/substrate-contract.js';

export interface RelaunchLivenessResult {
  readonly live: boolean;
  readonly detail: string;
}

export interface TranscriptSnapshot {
  readonly size: number;
  readonly mtimeMs: number;
}

export async function transcriptSnapshot(
  transcriptPath: string,
): Promise<TranscriptSnapshot | undefined> {
  try {
    const snapshot = await stat(transcriptPath);
    return { size: snapshot.size, mtimeMs: snapshot.mtimeMs };
  } catch {
    return undefined;
  }
}
/**
 * A socket can remain connectable after the hosted harness exits. Require both
 * the abduco listing's live marker and its hosted-command PID to be alive.
 */
export async function isSubstrateSessionLive(
  substrate: SubstrateClient,
  substrateName: string,
): Promise<boolean> {
  try {
    const sessions = await substrate.listSessions();
    const session = sessions.find((candidate) => candidate.name === substrateName);
    return session !== undefined && session.live && (await hostedChildIsLive(session.pid));
  } catch {
    try {
      return await substrate.isLive(substrateName);
    } catch {
      return false;
    }
  }
}

export async function waitForSubstrateSessionLive(
  substrate: SubstrateClient,
  substrateName: string,
): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  let delayMs = 25;
  while (true) {
    if (await isSubstrateSessionLive(substrate, substrateName)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(500, delayMs * 2);
  }
}

export async function createSessionWithAdoption(
  substrate: SubstrateClient,
  substrateName: string,
  argv: readonly string[],
  options?: SubstrateCreateOptions,
): Promise<SubstrateSessionInfo> {
  try {
    return await substrate.createSession(substrateName, argv, options);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !substrateName.startsWith('substrate-') ||
      substrateName.length === 'substrate-'.length ||
      !message.startsWith('abduco session did not become live within ') ||
      !message.endsWith(`: ${substrateName}`)
    )
      throw error;
    if (!(await waitForSubstrateSessionLive(substrate, substrateName))) {
      console.warn(
        `[session] substrate session ${substrateName} stayed dead after create timeout; preserving failure`,
      );
      throw error;
    }
    console.warn(
      `[session] adopted substrate session ${substrateName} after create liveness timeout`,
    );
    return { name: substrateName, live: true };
  }
}

async function hostedChildIsLive(serverPid: number | undefined): Promise<boolean> {
  if (serverPid === undefined) return true;
  try {
    const children = (
      await readFile(`/proc/${serverPid}/task/${serverPid}/children`, 'utf8')
    ).trim();
    return children.length > 0;
  } catch {
    return false;
  }
}
export async function verifyRelaunchLiveness(options: {
  readonly substrate: SubstrateClient;
  readonly substrateName: string;
  readonly transcriptPath: () => string;
  readonly baselinePath: string;
  readonly baselineSize: number;
  readonly baselineMtimeMs: number;
  readonly timeoutMs?: number;
}): Promise<RelaunchLivenessResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  let observedChildLive = false;
  while (Date.now() <= deadline) {
    const transcriptPath = options.transcriptPath();
    const snapshot = await transcriptSnapshot(transcriptPath);
    if (
      transcriptPath !== options.baselinePath ||
      (snapshot !== undefined &&
        (snapshot.size > options.baselineSize || snapshot.mtimeMs > options.baselineMtimeMs))
    ) {
      return { live: true, detail: 'transcript advanced' };
    }
    const child = await childLiveness(options.substrate, options.substrateName);
    if (child.known && !child.live) {
      return { live: false, detail: 'harness child exited after relaunch' };
    }
    if (child.live) {
      if (observedChildLive) return { live: true, detail: 'harness child remained live' };
      observedChildLive = true;
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return observedChildLive
    ? { live: true, detail: 'harness child remained live' }
    : { live: false, detail: 'harness child did not become live' };
}

interface ChildLiveness {
  readonly known: boolean;
  readonly live: boolean;
}

async function childLiveness(
  substrate: SubstrateClient,
  substrateName: string,
): Promise<ChildLiveness> {
  try {
    const sessions = await substrate.listSessions();
    const session = sessions.find((candidate) => candidate.name === substrateName);
    if (session !== undefined)
      return { known: true, live: session.live && (await hostedChildIsLive(session.pid)) };
  } catch {
    // Fall back to the substrate's liveness check for test and alternate clients.
  }
  try {
    return { known: false, live: await substrate.isLive(substrateName) };
  } catch {
    return { known: false, live: false };
  }
}
