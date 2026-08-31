import { IDLE_WORK_STATE, applyWorkEvent } from '../lib/session-state.js';
import { eventClock } from '../lib/time.js';
import { contextUsage } from './context-chip.js';

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
  if (typeof payload.provider === 'string') entry.provider = payload.provider;
  if (typeof payload.abort_key === 'string') entry.abort_key = payload.abort_key;
  if (typeof payload.cwd === 'string') entry.cwd = payload.cwd;
  if (typeof payload.project === 'string') entry.project = payload.project;
  // Every event folds into the work state, so "working" never depends on which branch runs below.
  entry.work = applyWorkEvent(entry.work ?? IDLE_WORK_STATE, event);
  entry.busy = entry.work.working;
  // session_context is a meter, not a turn: the harness restates the session's context-window
  // usage after every assistant record. Folding it onto the entry is what feeds the composer's
  // chip; letting it fall through to pushEventLine would stamp a `ctx` line into the conversation
  // on every single turn.
  if (event.type === 'session_context') {
    entry.context = contextUsage(payload);
    return;
  }
  const clock = eventClock(event.ts);
  if (event.type === 'session_started') {
    if (typeof payload.provider === 'string' && payload.provider.trim())
      entry.label = payload.provider;
    entry.status = 'running';
    entry.activity = undefined;
    entry.lastBoundaryAt = eventTimeMs(event.ts);
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
    entry.activity = undefined;
    entry.lastBoundaryAt = eventTimeMs(event.ts);
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
    const kind = sessionOutputKind(payload.kind);
    if (kind === 'thinking') {
      const eventTime = eventTimeMs(event.ts);
      const boundary =
        typeof entry.thinkingBoundaryAt === 'number'
          ? entry.thinkingBoundaryAt
          : (entry.lastBoundaryAt ?? eventTime);
      if (boundary !== undefined) entry.thinkingBoundaryAt = boundary;
      const elapsedSeconds =
        eventTime === undefined || boundary === undefined
          ? 0
          : Math.max(0, Math.round((eventTime - boundary) / 1000));
      entry.activity = { kind: 'thinking' };
      entry.busy = true;
      pushLine(entry, 'thinking', String(payload.text ?? ''), false, {
        streamKind: 'thinking',
        thinkingElapsedSeconds: elapsedSeconds,
      });
      return;
    }
    if (kind === 'tool') {
      const tool = sessionTool(payload.tool);
      finishThinking(entry);
      if (tool.status !== 'run') entry.lastBoundaryAt = eventTimeMs(event.ts);
      removeToolLine(entry, payload.index, tool);
      entry.activity = { kind: 'tool', name: tool.name, status: tool.status };
      entry.busy = true;
      pushLine(entry, 'agent', '', false, {
        streamKind: 'tool',
        outputIndex: payload.index,
        tool,
      });
      return;
    }
    finishThinking(entry);
    entry.lastBoundaryAt = eventTimeMs(event.ts);
    entry.activity = { kind: 'text' };
    pushLine(entry, 'agent', `${clock} agent · ${payload.text ?? ''}`, true);
    return;
  }
  if (event.type === 'turn_complete') {
    finishThinking(entry);
    entry.lastBoundaryAt = eventTimeMs(event.ts);
    pushLine(entry, 'divider', `— turn ${payload.turn ?? '?'} —`);
    return;
  }
  if (event.type === 'session_complete' || event.type === 'verify_failed') {
    const failed = event.type === 'verify_failed';
    const text = failed
      ? `${payload.stage ?? 'verify'}: ${payload.error ?? 'failed'}`
      : 'session ended';
    entry.status = failed ? 'failed' : 'done';
    entry.activity = undefined;
    pushLine(entry, failed ? 'bad' : 'meta', `${clock} ${text}`);
    return;
  }
  pushEventLine(entry, event, EVENT_TONES[event.type] ?? 'meta', pushLine);
}

function sessionOutputKind(value) {
  return value === 'thinking' || value === 'tool' ? value : 'text';
}

function sessionTool(value) {
  const tool = value && typeof value === 'object' ? value : {};
  const status = tool.status === 'ok' || tool.status === 'err' ? tool.status : 'run';
  return {
    name: typeof tool.name === 'string' && tool.name ? tool.name : 'tool',
    summary: typeof tool.summary === 'string' ? tool.summary : '',
    status,
    ...(typeof tool.ms === 'number' && Number.isFinite(tool.ms) ? { ms: tool.ms } : {}),
  };
}

function removeToolLine(entry, outputIndex, tool) {
  if (tool.status === 'run') return;
  const lineIndex = entry.lines.findLastIndex(
    (line) =>
      line.streamKind === 'tool' &&
      line.tool?.status === 'run' &&
      line.tool.name === tool.name &&
      line.tool.summary === tool.summary &&
      (!Number.isInteger(outputIndex) || line.outputIndex === outputIndex),
  );
  if (lineIndex >= 0) entry.lines.splice(lineIndex, 1);
}

function finishThinking(entry) {
  entry.thinkingBoundaryAt = undefined;
}

function eventTimeMs(timestamp) {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
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
