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
  const clock = eventClock(event.ts);
  if (entry.kind === 'session') {
    if (event.type === 'session_started') {
      if (typeof payload.provider === 'string' && payload.provider.trim())
        entry.label = payload.provider;
      entry.status = 'running';
      entry.busy = true;
      pushLine(entry, 'you', `${clock} you · ${payload.prompt ?? ''}`);
      pushLine(
        entry,
        'meta',
        `${clock} ${payload.provider ?? 'session'} · cwd ${payload.cwd ?? '(default cwd)'}`,
      );
      return;
    }
    if (event.type === 'session_input') {
      pushLine(entry, 'you', `${clock} you · ${payload.text ?? ''}`);
      return;
    }
    if (event.type === 'session_output') {
      pushLine(entry, 'agent', `${clock} agent · ${payload.text ?? ''}`, true);
      return;
    }
    if (event.type === 'turn_complete') {
      entry.busy = false;
      pushLine(entry, 'divider', `— turn ${payload.turn ?? '?'} —`);
      return;
    }
    if (event.type === 'session_complete' || event.type === 'verify_failed') {
      const failed = event.type === 'verify_failed';
      const text = failed
        ? `${payload.stage ?? 'verify'}: ${payload.error ?? 'failed'}`
        : 'session ended';
      entry.status = failed ? 'failed' : 'done';
      entry.busy = false;
      pushLine(entry, failed ? 'bad' : 'meta', `${clock} ${text}`);
      return;
    }
    pushEventLine(entry, event, EVENT_TONES[event.type] ?? 'meta', pushLine);
    return;
  }
  const template = templateFromPayload(payload);
  if (template) entry.label = template;
  pushEventLine(entry, event, EVENT_TONES[event.type] ?? 'meta', pushLine);
  if (event.type === 'verify_failed' || /(?:fail|error|denied|rejected)/i.test(event.type)) {
    entry.status = 'failed';
  } else if (
    event.type === 'session_complete' ||
    /(?:complete|completed|done|released|succeeded|success)$/i.test(event.type)
  ) {
    entry.status = 'done';
  } else if (event.type === 'session_started') entry.status = 'running';
}

function pushEventLine(entry, event, tone, pushLine) {
  pushLine(
    entry,
    tone,
    `${eventClock(event.ts)} ${event.type} · ${eventText(event.type, event.payload)}`,
  );
}

function templateFromPayload(payload) {
  if (typeof payload.template === 'string' && payload.template.trim()) return payload.template;
  if (typeof payload.template_name === 'string' && payload.template_name.trim())
    return payload.template_name;
  if (typeof payload.prompt === 'string' && payload.prompt.startsWith('workflow-template:'))
    return payload.prompt.slice('workflow-template:'.length) || 'workflow';
  return '';
}

function eventText(type, payload) {
  const value = payload && typeof payload === 'object' ? payload : {};
  if (type === 'action_requested' || type === 'action_approved' || type === 'action_denied')
    return `${value.action ?? 'action'} · request ${value.request_id ?? 'unknown'}`;
  if (type === 'merge_to_main')
    return `${value.branch ?? 'branch'} · ${value.commit_sha ?? ''}`.trim();
  return JSON.stringify(payload) ?? String(payload);
}
