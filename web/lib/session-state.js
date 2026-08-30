// "Working" is the ratified definition of a session mid-turn: a user input event with no
// assistant output or turn-complete after it. Derived purely from the event stream — the phone
// keeps no queue of its own, because the harness owns queue and steer semantics.

const USER_TYPES = new Set(['session_started', 'session_input']);
const REPLY_TYPES = new Set(['session_output', 'turn_complete']);
const TERMINAL_TYPES = new Set(['session_complete', 'verify_failed']);

export const IDLE_WORK_STATE = Object.freeze({
  lastUserSeq: -1,
  lastReplySeq: -1,
  working: false,
});

/**
 * Folds one event into a session's work state. Pure: returns the previous state unchanged when the
 * event says nothing about who spoke last, so callers can assign the result unconditionally.
 */
export function applyWorkEvent(state, event) {
  const type = event?.type;
  const seq = Number.isFinite(event?.seq) ? event.seq : 0;
  if (TERMINAL_TYPES.has(type)) {
    return { lastUserSeq: state.lastUserSeq, lastReplySeq: state.lastReplySeq, working: false };
  }
  if (USER_TYPES.has(type)) {
    const lastUserSeq = Math.max(state.lastUserSeq, seq);
    return {
      lastUserSeq,
      lastReplySeq: state.lastReplySeq,
      working: lastUserSeq > state.lastReplySeq,
    };
  }
  if (REPLY_TYPES.has(type)) {
    const lastReplySeq = Math.max(state.lastReplySeq, seq);
    return {
      lastUserSeq: state.lastUserSeq,
      lastReplySeq,
      working: state.lastUserSeq > lastReplySeq,
    };
  }
  return state;
}
