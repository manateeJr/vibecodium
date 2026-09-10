import { WebSocket } from 'ws';
import { createClient } from '../client/index.js';
import type { SocketConstructor, VibecodiumClient } from '../client/types.js';
import { postSessionAnswerAsk } from '../client/answer-ask.js';
import type {
  ActionRequestedPayload,
  EventEnvelope,
  SessionInputPayload,
  SessionOutputPayload,
  SessionStatePayload,
  TurnCompletePayload,
} from '../contracts/events.js';
import type {
  ObservedAsk,
  SessionAskBridge,
  SessionBridge,
  SessionLite,
  MachineSessionLite,
  TelegramConfig,
  TurnProgress,
  TurnResult,
} from './types.js';
import {
  asAskRequest,
  askId,
  askRoutedSessionId,
  askSessionId,
  askTurn,
  resolveAskDecision,
} from './ask-watch.js';

export function createSessionBridge(
  config: TelegramConfig,
  provider = 'omp',
): SessionBridge & SessionAskBridge {
  const client = createClient({
    baseUrl: config.controlPlaneUrl,
    // `ws` exposes the SDK's `.on` listener shape; its overloaded constructor needs this boundary cast.
    webSocket: WebSocket as unknown as SocketConstructor,
  });
  const baseUrl = config.controlPlaneUrl.replace(/\/+$/, '');
  const watchStartSeqByTurn = new Map<string, number>();
  const lastSeenSeqBySession = new Map<string, number>();
  // Recent omp-ask payloads by `${sessionId}:${askId}` so answerAsk can map the
  // tapped option to the approve/deny path. Bounded; evicts oldest first.
  const recentAsks = new Map<string, ActionRequestedPayload>();
  // Global action_requested cursor so each subscribeAsk starts near the tail.
  let askStartSeq = 0;
  const noteAsk = (sessionId: string, payload: ActionRequestedPayload): void => {
    recentAsks.set(`${sessionId}:${askId(payload)}`, payload);
    while (recentAsks.size > 64) {
      const oldest = recentAsks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      recentAsks.delete(oldest);
    }
  };

  return {
    health: async (): Promise<boolean> => {
      try {
        const response = await fetch(`${baseUrl}/healthz`, {
          signal: AbortSignal.timeout(5_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    projects: () =>
      controlPlaneCall('project list', async () => {
        const result = await client.listProjects();
        return result.projects.map(({ name, path }) => ({ name, path }));
      }),
    machineSessions: () =>
      controlPlaneCall('machine list', async () => {
        const result = await client.machineList();
        return result.sessions
          .filter((session) => session.kind === 'main')
          .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
          .map(({ source, ref, title, cwd, updated_at }): MachineSessionLite => ({
            source,
            ref,
            title,
            cwd,
            updatedAt: updated_at,
          }));
      }),
    open: ({ cwd, prompt, project }) =>
      controlPlaneCall('session open', async () => {
        const result = await client.openSession({
          provider,
          prompt,
          cwd,
          ...(project === undefined ? {} : { project }),
          origin: 'operator',
          source: 'api',
        });
        return { sessionId: result.session_id, turn: 1 };
      }),
    resume: ({ source, ref, prompt, cwd }) =>
      controlPlaneCall('session resume', async () => {
        const result = await client.resumeSession({
          source,
          ref,
          prompt,
          ...(cwd === undefined ? {} : { cwd }),
          origin: 'operator',
        });
        return { sessionId: result.session_id, turn: 1 };
      }),
    send: ({ sessionId, prompt }) =>
      controlPlaneCall('session send', async () => {
        const streamId = `session:${sessionId}`;
        const previousTailSeq = lastSeenSeqBySession.get(sessionId) ?? 0;
        const events = await client.getEvents(streamId, previousTailSeq);
        const streamTailSeq = events.at(-1)?.seq ?? previousTailSeq;
        lastSeenSeqBySession.set(sessionId, streamTailSeq);
        const result = await client.sendMessage({ session_id: sessionId, prompt });
        const sessionKeyPrefix = `${sessionId}:`;
        for (const key of watchStartSeqByTurn.keys()) {
          if (key.startsWith(sessionKeyPrefix)) watchStartSeqByTurn.delete(key);
        }
        watchStartSeqByTurn.set(`${sessionId}:${result.turn}`, streamTailSeq);
        return { turn: result.turn };
      }),
    transcribe: (args: { audio_base64: string; mime?: string }) =>
      controlPlaneCall('voice transcribe', () => client.transcribe(args)),
    attachImage: (args: {
      session_id: string;
      image_base64: string;
      mime?: string;
      filename?: string;
    }) =>
      controlPlaneCall('media attach', async () => {
        // The bridge posts tokenless like its control-plane client (loopback).
        const response = await fetch(`${baseUrl}/commands/media.attach`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
        });
        let body: unknown;
        try {
          body = (await response.json()) as unknown;
        } catch {
          throw new Error(`control plane returned HTTP ${response.status}`);
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error(
            response.ok
              ? 'control plane returned an invalid response'
              : `control plane returned HTTP ${response.status}`,
          );
        }
        if (!response.ok) {
          if ('error' in body && typeof body.error === 'string') throw new Error(body.error);
          throw new Error(`control plane returned HTTP ${response.status}`);
        }
        if (!('value' in body)) throw new Error('control plane returned an invalid response');
        const value = body.value;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('control plane returned an invalid response');
        }
        if (!('path' in value) || typeof value.path !== 'string') {
          throw new Error('control plane returned an invalid response');
        }
        if (!('size' in value) || typeof value.size !== 'number') {
          throw new Error('control plane returned an invalid response');
        }
        return { path: value.path, size: value.size };
      }),
    stop: (sessionId) =>
      controlPlaneCall('session stop', async () => {
        const result = await client.stopSession({ session_id: sessionId });
        return result.stopped;
      }),
    rename: ({ sessionId, label }): Promise<void> =>
      controlPlaneCall('session rename', async () => {
        await client.sessionRename({ session_id: sessionId, label });
      }),
    list: () =>
      controlPlaneCall('session list', async () => {
        const result = await client.listSessions({});
        return result.sessions.map((summary): SessionLite => ({
          sessionId: summary.session_id,
          status: summary.status,
          ...(summary.label === undefined ? {} : { label: summary.label }),
          ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
          ...(summary.prompt === undefined ? {} : { prompt: summary.prompt }),
          ...((summary.updated_at ?? summary.started_at) === undefined
            ? {}
            : { updatedAt: summary.updated_at ?? summary.started_at }),
        }));
      }),
    subscribeSession: ({ sessionId, onTurn, onState, onAsk }) => {
      const streamId = `session:${sessionId}`;
      const inProgress = new Map<number, { prompt: string; text: string }>();
      let cancelled = false;
      let unsubscribe: (() => void) | undefined;
      const receive = (event: EventEnvelope): void => {
        if (cancelled || event.stream_id !== streamId) return;
        if (event.type === 'session_input') {
          const payload = event.payload as SessionInputPayload;
          if (payload.session_id !== sessionId) return;
          inProgress.set(payload.turn, { prompt: payload.text, text: '' });
          if (inProgress.size > 8) {
            let lowest: number | undefined;
            for (const turn of inProgress.keys()) {
              if (lowest === undefined || turn < lowest) lowest = turn;
            }
            if (lowest !== undefined) inProgress.delete(lowest);
          }
          return;
        }
        if (event.type === 'session_output') {
          const payload = event.payload as SessionOutputPayload;
          if (
            payload.session_id !== sessionId ||
            (payload.kind !== undefined && payload.kind !== 'text')
          )
            return;
          let currentTurn: number | undefined;
          for (const turn of inProgress.keys()) {
            if (currentTurn === undefined || turn > currentTurn) currentTurn = turn;
          }
          if (currentTurn === undefined) return;
          const current = inProgress.get(currentTurn);
          if (current !== undefined) current.text += payload.text;
          return;
        }
        if (event.type === 'turn_complete') {
          const payload = event.payload as TurnCompletePayload;
          if (payload.session_id !== sessionId) return;
          const observed = inProgress.get(payload.turn);
          if (observed === undefined) return;
          inProgress.delete(payload.turn);
          onTurn({
            sessionId,
            turn: payload.turn,
            prompt: observed.prompt,
            text: observed.text,
            completedAt: new Date().toISOString(),
          });
          return;
        }
        if (event.type === 'action_requested') {
          const payload = event.payload as ActionRequestedPayload;
          if (asAskRequest(payload) === null) return;
          if (askSessionId(payload, sessionId) !== sessionId) return;
          noteAsk(sessionId, payload);
          onAsk?.({ sessionId, turn: askTurn(payload), payload });
          return;
        }
        if (event.type === 'session_state') {
          const payload = event.payload as SessionStatePayload;
          if (payload.session_id === sessionId) onState?.(payload.state);
        }
      };
      const bootstrap = async (): Promise<void> => {
        const events = await client.getEvents(streamId, 0);
        if (cancelled) return;
        const tail = events.at(-1)?.seq ?? 0;
        unsubscribe = client.subscribe(tail, receive, streamId);
        if (cancelled) {
          unsubscribe();
          unsubscribe = undefined;
        }
      };
      void bootstrap().catch(() => undefined);
      return (): void => {
        if (cancelled) return;
        cancelled = true;
        const removeSubscription = unsubscribe;
        unsubscribe = undefined;
        removeSubscription?.();
      };
    },
    openTurn: (sessionId) =>
      controlPlaneCall('session open turn', async () => {
        const streamId = `session:${sessionId}`;
        const events = await client.getEvents(streamId, 0);
        const openInputs = new Map<number, number>();
        for (const [index, event] of events.slice(-500).entries()) {
          if (event.type === 'session_input') {
            const payload = event.payload as SessionInputPayload;
            if (payload.session_id === sessionId) openInputs.set(payload.turn, index);
          } else if (event.type === 'turn_complete') {
            const payload = event.payload as TurnCompletePayload;
            if (payload.session_id === sessionId) openInputs.delete(payload.turn);
          }
        }
        let latestTurn: number | undefined;
        let latestIndex = -1;
        for (const [turn, index] of openInputs) {
          if (index > latestIndex) {
            latestTurn = turn;
            latestIndex = index;
          }
        }
        return latestTurn ?? null;
      }),
    watchTurn: ({ sessionId, turn, onProgress, timeoutMs, onAsk }) => {
      const key = `${sessionId}:${turn}`;
      const fromSeq = watchStartSeqByTurn.get(key);
      watchStartSeqByTurn.delete(key);
      const forwardAsk =
        onAsk === undefined
          ? undefined
          : (ask: ObservedAsk): void => {
              noteAsk(sessionId, ask.payload);
              onAsk(ask);
            };
      return watchTurn(client, sessionId, turn, fromSeq, onProgress, timeoutMs, forwardAsk);
    },
    subscribeAsk: (cb) => {
      const receive = (event: EventEnvelope): void => {
        if (event.seq > askStartSeq) askStartSeq = event.seq;
        if (event.type !== 'action_requested') return;
        const payload = event.payload as ActionRequestedPayload;
        if (asAskRequest(payload) === null) return;
        const routed = askRoutedSessionId(payload);
        if (routed === null) return;
        noteAsk(routed, payload);
        cb({ sessionId: routed, turn: askTurn(payload), payload });
      };
      return client.subscribe(askStartSeq, receive, '*');
    },
    answerAsk: ({ session_id, ask_id, question_id, option_index }) =>
      controlPlaneCall('session answer ask', async () => {
        const cached = recentAsks.get(`${session_id}:${ask_id}`) ?? null;
        const { approved } = resolveAskDecision(cached === null ? null : asAskRequest(cached), {
          question_id,
          option_index,
        });
        // The bridge posts tokenless like its control-plane client (loopback).
        const result = await postSessionAnswerAsk(baseUrl, {
          session_id,
          ask_id,
          question_id,
          option_index,
          approved,
        });
        if (result.status === 'denied') return { status: 'denied' as const };
        return undefined;
      }),
  };
}

async function controlPlaneCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error: unknown) {
    throw new Error(
      `control plane ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function watchTurn(
  client: VibecodiumClient,
  sessionId: string,
  turn: number,
  fromSeq: number | undefined,
  onProgress: (progress: TurnProgress) => void,
  timeoutMs: number,
  onAsk?: (ask: ObservedAsk) => void,
): Promise<TurnResult> {
  return new Promise<TurnResult>((resolve, reject) => {
    const streamId = `session:${sessionId}`;
    let collecting = turn === 1;
    const startedAt = Date.now();
    let output = '';
    let toolCalls = 0;
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const removeSubscription = unsubscribe;
      unsubscribe = undefined;
      removeSubscription?.();
    };
    const elapsedMs = (): number => Date.now() - startedAt;
    const finish = (result: TurnResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (message: string): void => {
      finish({
        status: 'failed',
        text: output || message,
        elapsedMs: elapsedMs(),
        toolCalls,
      });
    };
    const receive = (event: EventEnvelope): void => {
      if (settled || event.stream_id !== streamId) return;
      if (event.type === 'session_input') {
        const payload = event.payload as SessionInputPayload;
        if (payload.session_id === sessionId && payload.turn === turn) collecting = true;
        return;
      }
      if (event.type === 'session_output') {
        const payload = event.payload as SessionOutputPayload;
        if (!collecting || payload.session_id !== sessionId) return;
        if (payload.kind === 'tool') toolCalls += 1;
        else if (payload.kind === undefined || payload.kind === 'text') output += payload.text;
        onProgress({ elapsedMs: elapsedMs(), toolCalls });
        return;
      }
      if (event.type === 'turn_complete') {
        const payload = event.payload as TurnCompletePayload;
        if (payload.session_id !== sessionId) return;
        if (payload.turn === turn) {
          if (collecting)
            finish({ status: 'complete', text: output, elapsedMs: elapsedMs(), toolCalls });
          return;
        }
        if (!collecting && payload.turn === turn - 1) collecting = true;
        return;
      }
      if (event.type === 'action_requested') {
        // Surface the pending ask alongside the wait; the turn stays open and the
        // existing complete/failed/timeout outcomes are unchanged (no early close).
        const payload = event.payload as ActionRequestedPayload;
        if (asAskRequest(payload) === null) return;
        const routed = askRoutedSessionId(payload);
        if (routed !== null && routed !== sessionId) return;
        const askTurnValue = askTurn(payload);
        if (askTurnValue !== null && askTurnValue !== turn) return;
        onAsk?.({ sessionId, turn: askTurnValue ?? turn, payload });
        return;
      }
      const eventType = event.type as string;
      if (eventType !== 'verify_failed' && eventType !== 'session_failed') return;
      const payload = event.payload as { readonly session_id?: unknown; readonly error?: unknown };
      if (payload.session_id !== undefined && payload.session_id !== sessionId) return;
      fail(typeof payload.error === 'string' ? payload.error : 'session failed');
    };

    try {
      // Start after the stream tail captured before this send so replay cannot match an earlier turn.
      // The initial open turn has no session_input, so turn 1 uses stream output as fallback.
      unsubscribe = client.subscribe(fromSeq ?? 0, receive, streamId);
      if (settled) {
        cleanup();
        return;
      }
      timer = setTimeout(
        () => {
          finish({ status: 'timeout', text: output, elapsedMs: elapsedMs(), toolCalls });
        },
        Math.max(0, timeoutMs),
      );
    } catch (error: unknown) {
      cleanup();
      reject(
        new Error(
          `control plane event subscription failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  });
}
