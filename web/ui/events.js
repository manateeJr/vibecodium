import { IDLE_WORK_STATE, applyWorkEvent } from '../lib/session-state.js';
import { eventClock } from '../lib/time.js';

const EVENT_TONES = Object.freeze({
  session_started: 'ok',
  session_output: 'normal',
  session_complete: 'ok',
  verify_failed: 'bad',
  action_requested: 'wait',
  action_approved: 'ok',
  action_denied: 'bad',
  merge_to_main: 'ok',
  proposal_queued: 'wait',
  proposal_approved: 'ok',
  notify_emitted: 'meta',
  inbound_received: 'meta',
});

export function applySessionEvent(entry, event, pushLine) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  if (typeof payload.session_id === 'string') entry.session_id = payload.session_id;
  if (typeof payload.cwd === 'string') entry.cwd = payload.cwd;
  if (typeof payload.project === 'string') entry.project = payload.project;
  // Every event folds into the work state, so "working" never depends on which branch runs below.
  entry.work = applyWorkEvent(entry.work ?? IDLE_WORK_STATE, event);
  entry.busy = entry.work.working;
  const clock = eventClock(event.ts);
  if (event.type === 'session_started') {
    if (typeof payload.provider === 'string' && payload.provider.trim())
      entry.label = payload.provider;
    entry.status = 'running';
    pushLine(entry, 'you', `${clock} you · ${payload.prompt ?? ''}`);
    pushLine(
      entry,
      'meta',
      `${clock} ${payload.provider ?? 'session'} · cwd ${payload.cwd ?? '(default cwd)'}`,
    );
    return;
  }
  if (event.type === 'session_input') {
    // Steering messages are marked on the wire; the transcript renders them distinctly and offers
    // "Steer now" while they are still queued behind the turn in flight.
    const steering = payload.steering === true;
    pushLine(
      entry,
      steering ? 'steering' : 'you',
      `${clock} ${steering ? 'queued' : 'you'} · ${payload.text ?? ''}`,
      false,
      steering ? { steering: true } : undefined,
    );
    return;
  }
  if (event.type === 'session_output') {
    pushLine(entry, 'agent', `${clock} agent · ${payload.text ?? ''}`, true);
    return;
  }
  if (event.type === 'turn_complete') {
    pushLine(entry, 'divider', `— turn ${payload.turn ?? '?'} —`);
    return;
  }
  if (event.type === 'session_complete' || event.type === 'verify_failed') {
    const failed = event.type === 'verify_failed';
    const text = failed
      ? `${payload.stage ?? 'verify'}: ${payload.error ?? 'failed'}`
      : 'session ended';
    entry.status = failed ? 'failed' : 'done';
    pushLine(entry, failed ? 'bad' : 'meta', `${clock} ${text}`);
    return;
  }
  pushEventLine(entry, event, EVENT_TONES[event.type] ?? 'meta', pushLine);
}

function pushEventLine(entry, event, tone, pushLine) {
  pushLine(
    entry,
    tone,
    `${eventClock(event.ts)} ${event.type} · ${eventText(event.type, event.payload)}`,
  );
}

function eventText(type, payload) {
  const value = payload && typeof payload === 'object' ? payload : {};
  if (type === 'action_requested' || type === 'action_approved' || type === 'action_denied')
    return `${value.action ?? 'action'} · request ${value.request_id ?? 'unknown'}`;
  if (type === 'merge_to_main')
    return `${value.branch ?? 'branch'} · ${value.commit_sha ?? ''}`.trim();
  return JSON.stringify(payload) ?? String(payload);
}
