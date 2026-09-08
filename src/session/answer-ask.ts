import {
  SESSION_ANSWER_ASK_COMMAND,
  type SessionAnswerAskArgs,
  type SessionAnswerAskResult,
} from '../contracts/session-commands.js';
import type { ActionEventPayload } from '../contracts/events.js';
import type { SubsystemContext } from '../contracts/subsystem.js';

export { SESSION_ANSWER_ASK_COMMAND };

/** Decision delivered to the pending omp ask (mirrors the tailer resolveAsk seam). */
export interface AskAnswerDecision {
  readonly approved: boolean;
  readonly questionId?: string;
  readonly optionIndex?: number;
}

export type ResolvePendingAsk = (
  sessionId: string,
  askId: string,
  decision: AskAnswerDecision,
) => boolean;

export interface AnswerAskDependencies {
  readonly append: SubsystemContext['append'];
  readonly resolvePendingAsk: ResolvePendingAsk;
}

interface AskResolvingTailer {
  resolveAsk?: (askId: string, decision: AskAnswerDecision) => boolean;
}

interface AskResolvingWorker {
  tailer?: AskResolvingTailer | null;
}

interface AskResolvingManager {
  workers?: { get(sessionId: string): unknown };
}

/**
 * Resolve a pending ask through a live persistent worker without touching the
 * capped manager/worker modules: the subsystem hands its (private) manager
 * here and this delegate structural-casts down to the tailer. Each absent hop
 * resolves false so answers degrade to event-only audit records. The
 * AskProducer lane owns the tailer resolveAsk implementation; this delegate is
 * replaced by typed calls if those modules are ever split.
 */
export function resolveAskViaManager(
  manager: unknown,
  sessionId: string,
  askId: string,
  decision: AskAnswerDecision,
): boolean {
  const workers = (manager as AskResolvingManager | null | undefined)?.workers;
  const tailer = (workers?.get(sessionId) as AskResolvingWorker | null | undefined)?.tailer;
  return tailer?.resolveAsk?.(askId, decision) ?? false;
}

/** Command handler factory; keeps session/index.ts to a two-line wiring. */
export function answerAskHandler(
  context: Pick<SubsystemContext, 'append'>,
  manager: unknown,
): (command: unknown) => SessionAnswerAskResult {
  const append = context.append.bind(context);
  return (command: unknown) =>
    answerAskSession(
      {
        append,
        resolvePendingAsk: (sessionId, askId, decision) =>
          resolveAskViaManager(manager, sessionId, askId, decision),
      },
      command,
    );
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`session.answer_ask requires a non-empty string '${field}'`);
  }
  return value;
}

export function answerAskArgs(command: unknown): SessionAnswerAskArgs {
  const record =
    typeof command === 'object' && command !== null && !Array.isArray(command)
      ? (command as Record<string, unknown>)
      : null;
  if (record === null) throw new Error('session.answer_ask requires an argument object');
  const optionIndex = record.option_index;
  if (typeof optionIndex !== 'number' || !Number.isInteger(optionIndex) || optionIndex < 0) {
    throw new Error('session.answer_ask requires a non-negative integer option_index');
  }
  if (typeof record.approved !== 'boolean') {
    throw new Error('session.answer_ask requires a boolean approved flag');
  }
  return {
    session_id: requiredString(record, 'session_id'),
    ask_id: requiredString(record, 'ask_id'),
    question_id: requiredString(record, 'question_id'),
    option_index: optionIndex,
    approved: record.approved,
  };
}

/**
 * Record the tapped option as action_approved / action_denied on the session
 * stream (single subscription sees ask + answer) and resolve the pending omp
 * ask so the turn proceeds. Returns whether a live tailer consumed the answer.
 */
export function answerAskSession(
  deps: AnswerAskDependencies,
  command: unknown,
): SessionAnswerAskResult {
  const args = answerAskArgs(command);
  const resolved = deps.resolvePendingAsk(args.session_id, args.ask_id, {
    approved: args.approved,
    questionId: args.question_id,
    optionIndex: args.option_index,
  });
  // Canonical base fields keep this a valid ActionEventPayload today; the
  // trailing ask fields are the pinned #116 shape the canonical extension adopts.
  const payload = {
    request_id: args.ask_id,
    action: 'omp.ask.answer',
    scope: { session_id: args.session_id },
    session_id: args.session_id,
    ask_id: args.ask_id,
    question_id: args.question_id,
    option_index: args.option_index,
  } as ActionEventPayload;
  deps.append(
    `session:${args.session_id}`,
    args.approved ? 'action_approved' : 'action_denied',
    payload,
  );
  return { status: args.approved ? 'approved' : 'denied', resolved };
}
