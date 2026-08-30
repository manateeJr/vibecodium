import type { SessionOpenArgs, SessionOpenResult } from '../contracts/commands.js';
import type { SubsystemContext } from '../contracts/subsystem.js';
import { SessionThrottledError, type AdmissionBudget } from './admission.js';
import type { PersistentSessionManager } from './persistent-session-manager.js';

export interface PersistentSessionStartOptions {
  readonly args: SessionOpenArgs;
  readonly resumeRef?: string;
  readonly active: number;
  readonly admission: AdmissionBudget;
  readonly idFactory: () => string;
  readonly context: SubsystemContext;
  readonly manager: PersistentSessionManager;
  readonly onStarted: (sessionId: string) => void;
}

export async function startPersistentSession(
  options: PersistentSessionStartOptions,
): Promise<SessionOpenResult> {
  const decision = options.admission.tryAdmit(options.active);
  if (!decision.ok) throw new SessionThrottledError(decision);
  const session_id = options.idFactory();
  if (!session_id.trim()) throw new Error('session id is required');
  const stream_id = `session:${session_id}`;
  options.context.append(stream_id, 'session_started', {
    session_id,
    provider: options.args.provider,
    prompt: options.args.prompt,
    ...(options.args.cwd === undefined ? {} : { cwd: options.args.cwd }),
    ...(options.args.project === undefined ? {} : { project: options.args.project }),
  });
  try {
    await options.manager.start(options.args, session_id, stream_id, options.resumeRef);
    options.onStarted(session_id);
    return { session_id, stream_id };
  } catch (error) {
    options.context.append(stream_id, 'verify_failed', {
      session_id,
      stage: 'session',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
