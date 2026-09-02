import { WebSocket } from 'ws';
import { createClient } from '../client/index.js';
import type { SocketConstructor, VibecodiumClient } from '../client/types.js';
import type {
  EventEnvelope,
  SessionInputPayload,
  SessionOutputPayload,
  TurnCompletePayload,
} from '../contracts/events.js';
import type {
  SessionBridge,
  SessionLite,
  MachineSessionLite,
  TelegramConfig,
  TurnProgress,
  TurnResult,
} from './types.js';

export function createSessionBridge(config: TelegramConfig, provider = 'omp'): SessionBridge {
  const client = createClient({
    baseUrl: config.controlPlaneUrl,
    // `ws` exposes the SDK's `.on` listener shape; its overloaded constructor needs this boundary cast.
    webSocket: WebSocket as unknown as SocketConstructor,
  });
  const baseUrl = config.controlPlaneUrl.replace(/\/+$/, '');

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
        const result = await client.sendMessage({ session_id: sessionId, prompt });
        return { turn: result.turn };
      }),
    stop: (sessionId) =>
      controlPlaneCall('session stop', async () => {
        const result = await client.stopSession({ session_id: sessionId });
        return result.stopped;
      }),
    list: () =>
      controlPlaneCall('session list', async () => {
        const result = await client.listSessions({});
        return result.sessions.map((summary): SessionLite => ({
          sessionId: summary.session_id,
          status: summary.status,
          ...(summary.label === undefined ? {} : { label: summary.label }),
          ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
        }));
      }),
    watchTurn: ({ sessionId, turn, onProgress, timeoutMs }) =>
      watchTurn(client, sessionId, turn, onProgress, timeoutMs),
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
  onProgress: (progress: TurnProgress) => void,
  timeoutMs: number,
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
      const eventType = event.type as string;
      if (eventType !== 'verify_failed' && eventType !== 'session_failed') return;
      const payload = event.payload as { readonly session_id?: unknown; readonly error?: unknown };
      if (payload.session_id !== undefined && payload.session_id !== sessionId) return;
      fail(typeof payload.error === 'string' ? payload.error : 'session failed');
    };

    try {
      // Replay from zero preserves an input emitted before subscription and avoids lost output.
      // The initial open turn has no session_input, so turn 1 uses stream output as fallback.
      unsubscribe = client.subscribe(0, receive, streamId);
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
