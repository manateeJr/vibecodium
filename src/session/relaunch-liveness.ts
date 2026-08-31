import { readFile, stat } from 'node:fs/promises';
import type { SubstrateClient } from '../contracts/substrate-contract.js';

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
