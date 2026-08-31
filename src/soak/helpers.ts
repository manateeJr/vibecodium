import type { EventEnvelope, EventKind } from '../contracts/events.js';
import type { SessionSummary } from '../contracts/session-commands.js';
import { asRecord } from '../session/session-helpers.js';

export type SoakProvider = 'fake' | 'omp';

export interface SoakOptions {
  readonly provider: SoakProvider;
  readonly minutes: number;
}

export interface SoakInvariantReport {
  readonly eventCount: number;
  readonly turnCount: number;
  readonly replayCount: number;
  readonly kinds: Readonly<Record<EventKind, number>>;
}
export const SOAK_PHASES = [
  'open',
  'multi-turn',
  'steering',
  'send_keys',
  'share-intake',
  'rename/recent',
  'restart',
  'reap/resume',
  'invariants',
] as const;

export const SOAK_FAKE_DURATION_MS = 2 * 60 * 1000;

const EVENT_KINDS: readonly EventKind[] = [
  'session_started',
  'session_forked',
  'session_output',
  'session_complete',
  'session_input',
  'turn_complete',
  'verify_failed',
  'action_requested',
  'action_approved',
  'action_denied',
  'merge_to_main',
  'proposal_queued',
  'proposal_approved',
  'notify_emitted',
  'inbound_received',
  'session_state',
];
const EVENT_KIND_MAP: Readonly<Record<string, true>> = Object.fromEntries(
  EVENT_KINDS.map((kind) => [kind, true]),
) as Readonly<Record<string, true>>;

export function parseSoakArgs(args: readonly string[]): SoakOptions {
  let provider: SoakProvider = 'omp';
  let minutes = 30;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) throw new Error('soak option is missing');
    if (arg === '--provider' || arg === '--minutes') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--provider') {
        if (value !== 'fake' && value !== 'omp')
          throw new Error(`--provider must be fake or omp (received ${value})`);
        provider = value;
      } else {
        minutes = parseMinutes(value);
      }
      continue;
    }
    if (arg.startsWith('--provider=')) {
      const value = arg.slice('--provider='.length);
      if (value !== 'fake' && value !== 'omp')
        throw new Error(`--provider must be fake or omp (received ${value})`);
      provider = value;
      continue;
    }
    if (arg.startsWith('--minutes=')) {
      minutes = parseMinutes(arg.slice('--minutes='.length));
      continue;
    }
    if (arg === '--help' || arg === '-h') throw new Error(usageText());
    throw new Error(`unknown soak option: ${arg}\n${usageText()}`);
  }
  return { provider, minutes };
}

export function soakDurationMs(options: SoakOptions): number {
  const requested = options.minutes * 60 * 1000;
  return options.provider === 'fake' ? Math.min(SOAK_FAKE_DURATION_MS, requested) : requested;
}

export function usageText(): string {
  return 'usage: npm run soak -- [--provider fake|omp] [--minutes N]';
}

export function assertEventInvariants(
  events: readonly EventEnvelope[],
  streamId?: string,
): SoakInvariantReport {
  if (events.length === 0) throw new Error('event store is empty');
  const pendingTurns = new Map<number, number>();
  const steeringTurns = new Map<number, number>();
  const completedTurns = new Map<number, number>();
  let inputCount = 0;
  let completeCount = 0;
  const kinds = Object.fromEntries(EVENT_KINDS.map((kind) => [kind, 0])) as Record<
    EventKind,
    number
  >;
  let previousSeq = 0;
  let sessionId: string | undefined;
  let initialPrompt = false;
  let implicitInitialTurn = false;
  for (const event of events) {
    if (!Number.isInteger(event.seq) || event.seq <= previousSeq)
      throw new Error(`event sequence is not strictly increasing at ${event.seq}`);
    previousSeq = event.seq;
    if (streamId !== undefined && event.stream_id !== streamId)
      throw new Error(`event stream mismatch: expected ${streamId}, got ${event.stream_id}`);
    if (!event.stream_id.trim() || !EVENT_KIND_MAP[event.type])
      throw new Error(`malformed event envelope at seq ${event.seq}`);
    kinds[event.type] += 1;
    const payload = asRecord(event.payload);
    if (!payload || !Number.isFinite(Date.parse(event.ts)))
      throw new Error(`malformed event payload at seq ${event.seq}`);
    if (event.type === 'session_started') {
      requireSessionId(payload, event.seq);
      if (typeof payload.prompt === 'string' && payload.prompt.trim()) initialPrompt = true;
      if (sessionId === undefined) sessionId = payload.session_id as string;
    } else if (event.type === 'session_input') {
      requireSessionId(payload, event.seq);
      const turn = positiveInteger(payload.turn, `session_input turn at seq ${event.seq}`);
      if (typeof payload.text !== 'string')
        throw new Error(`session_input text missing at seq ${event.seq}`);
      if (payload.steering === true) {
        steeringTurns.set(turn, (steeringTurns.get(turn) ?? 0) + 1);
      } else {
        pendingTurns.set(turn, (pendingTurns.get(turn) ?? 0) + 1);
        inputCount += 1;
      }
    } else if (event.type === 'turn_complete') {
      requireSessionId(payload, event.seq);
      const turn = positiveInteger(payload.turn, `turn_complete turn at seq ${event.seq}`);
      const pending = pendingTurns.get(turn) ?? 0;
      const steering = steeringTurns.get(turn) ?? 0;
      const completed = completedTurns.get(turn) ?? 0;
      if (pending > 0) {
        if (pending === 1) pendingTurns.delete(turn);
        else pendingTurns.set(turn, pending - 1);
      } else if (turn === 1 && initialPrompt && !implicitInitialTurn) {
        implicitInitialTurn = true;
        inputCount += 1;
      } else if (steering > 0 && completed > 0) {
        if (steering === 1) steeringTurns.delete(turn);
        else steeringTurns.set(turn, steering - 1);
      } else {
        throw new Error(`turn ${turn} completed without a pending input`);
      }
      completedTurns.set(turn, completed + 1);
      completeCount += 1;
    } else if (event.type === 'session_output') {
      requireSessionId(payload, event.seq);
      if (!Number.isInteger(payload.index) || (payload.index as number) < 0)
        throw new Error(`session_output index missing at seq ${event.seq}`);
      if (typeof payload.text !== 'string')
        throw new Error(`session_output text missing at seq ${event.seq}`);
    } else if (event.type === 'session_complete' || event.type === 'session_state') {
      requireSessionId(payload, event.seq);
    }
    if (
      sessionId !== undefined &&
      payload.session_id !== undefined &&
      payload.session_id !== sessionId
    )
      throw new Error(`event session mismatch at seq ${event.seq}`);
  }
  if (completeCount < inputCount)
    throw new Error(
      `turn completion count mismatch: inputs=${inputCount} completes=${completeCount}`,
    );
  if (pendingTurns.size > 0)
    throw new Error(`unfinished turns: ${[...pendingTurns.keys()].join(', ')}`);
  return {
    eventCount: events.length,
    turnCount: inputCount,
    replayCount: events.length,
    kinds,
  };
}

export function assertReplayMatchesLive(
  live: readonly EventEnvelope[],
  replayed: readonly EventEnvelope[],
): void {
  if (live.length !== replayed.length)
    throw new Error(`event replay count mismatch: live=${live.length} replay=${replayed.length}`);
  for (let index = 0; index < live.length; index += 1) {
    if (JSON.stringify(live[index]) !== JSON.stringify(replayed[index]))
      throw new Error(`event replay mismatch at index ${index}`);
  }
}

export function assertNoStuckSessions(sessions: readonly SessionSummary[]): void {
  const stuck = sessions.filter((session) => session.status === 'live');
  if (stuck.length > 0)
    throw new Error(
      `stuck live sessions: ${stuck.map((session) => session.session_id).join(', ')}`,
    );
}

function parseMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw new Error(`--minutes must be positive (received ${value})`);
  return minutes;
}

function requireSessionId(payload: Record<string, unknown>, seq: number): void {
  if (typeof payload.session_id !== 'string' || !payload.session_id.trim())
    throw new Error(`session_id missing at seq ${seq}`);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} is invalid`);
  return value as number;
}
