import type { SessionStateReason } from '../contracts/events.js';
import type {
  SubstrateAttachment,
  SubstrateClient,
  SubstrateSessionRecord,
} from '../contracts/substrate-contract.js';
import type { PersistentSessionManager } from './persistent-session-manager.js';
import { isSubstrateSessionLive } from './relaunch-liveness.js';

export type ReconcileAttachmentState = 'live' | 'resumable';

export async function attachReconciledRecord(
  record: SubstrateSessionRecord,
  substrate: SubstrateClient,
  persistentManager: PersistentSessionManager | undefined,
  sessionStorageDirs: Map<string, string>,
  substrateAttachments: Map<string, SubstrateAttachment>,
  reconciledSubstrateSessions: Set<string>,
  onStateChange: (
    sessionId: string,
    state: ReconcileAttachmentState,
    reason: SessionStateReason,
  ) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (persistentManager?.supports(record.provider)) {
        const updated = await persistentManager.attach(record);
        sessionStorageDirs.set(record.sessionId, updated.storageDir);
      } else {
        const attachment = await substrate.attach(record.substrateName);
        substrateAttachments.set(record.sessionId, attachment);
      }
      return;
    } catch {
      // attach attempt failed; retry once, then fall through to the liveness check
    }
  }
  const state: ReconcileAttachmentState = (await isSubstrateSessionLive(
    substrate,
    record.substrateName,
  ))
    ? 'live'
    : 'resumable';
  reconciledSubstrateSessions[state === 'live' ? 'add' : 'delete'](record.sessionId);
  onStateChange(record.sessionId, state, 'reconciled');
}
