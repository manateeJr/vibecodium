import { SESSION_ANSWER_ASK_COMMAND } from '../contracts/session-commands.js';
import type {
  SessionAnswerAskArgs,
  SessionAnswerAskResult,
} from '../contracts/session-commands.js';
import { post } from './index.js';

/**
 * session.answer_ask transport (issue #116). Lives in this module — instead of
 * a createClient method — so src/client/index.ts stays under the file cap.
 * The bridge never authenticates (matching its tokenless client); loopback
 * control planes accept the command without a bearer token.
 */
export function postSessionAnswerAsk(
  baseUrl: string,
  args: SessionAnswerAskArgs,
): Promise<SessionAnswerAskResult> {
  return post<SessionAnswerAskResult>(baseUrl, SESSION_ANSWER_ASK_COMMAND, args, undefined);
}
