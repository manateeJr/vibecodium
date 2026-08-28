import type { EventHandler, Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { TelemetryStore, type TelemetryStoreOptions } from './store.js';

export {
  DEFAULT_TELEMETRY_DB_PATH,
  TELEMETRY_DB_PATH_ENV,
  TelemetryStore,
  normalizeErrorClass,
  resolveTelemetryDbPath,
  signatureFor,
} from './store.js';
export type { TelemetryStoreOptions } from './store.js';

export const TELEMETRY_PROJECTOR_NAME = 'telemetry';
export const TELEMETRY_RECORD_COMMAND = 'telemetry.record';

export interface TelemetryRecordCommand {
  readonly stream_id?: string;
  readonly stage: string;
  readonly error: string;
  readonly error_class?: string;
  readonly session_id?: string;
}

export interface TelemetrySubsystem extends Subsystem {
  readonly store: TelemetryStore;
}

export interface TelemetrySubsystemOptions extends TelemetryStoreOptions {
  readonly from_seq?: number;
}

export function createTelemetrySubsystem(
  options: TelemetrySubsystemOptions = {},
): TelemetrySubsystem {
  const store = new TelemetryStore(options);
  return {
    name: TELEMETRY_PROJECTOR_NAME,
    store,
    register(ctx: SubsystemContext): void {
      registerTelemetry(ctx, store, options.from_seq);
    },
  };
}

export function register(ctx: SubsystemContext, from_seq?: number): void {
  const store = new TelemetryStore();
  registerTelemetry(ctx, store, from_seq);
}

function registerTelemetry(ctx: SubsystemContext, store: TelemetryStore, from_seq?: number): void {
  const onEvent: EventHandler = (event) => store.projectEvent(event);
  ctx.registerProjector(TELEMETRY_PROJECTOR_NAME, onEvent, from_seq);
  ctx.registerCommand(TELEMETRY_RECORD_COMMAND, (command: unknown) => {
    const input = parseRecordCommand(command);
    const payload = {
      stage: input.stage,
      error: input.error,
      ...(input.error_class ? { error_class: input.error_class } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
    };
    return ctx.append(input.stream_id ?? 'telemetry', 'verify_failed', payload);
  });
}

function parseRecordCommand(command: unknown): TelemetryRecordCommand {
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    throw new Error('telemetry.record command must be an object');
  }
  const input = command as Record<string, unknown>;
  const stage = requiredString(input.stage, 'stage');
  const error = requiredString(input.error, 'error');
  const stream_id = optionalString(input.stream_id, 'stream_id');
  const error_class = optionalString(input.error_class, 'error_class');
  const session_id = optionalString(input.session_id, 'session_id');
  return {
    ...(stream_id ? { stream_id } : {}),
    stage,
    error,
    ...(error_class ? { error_class } : {}),
    ...(session_id ? { session_id } : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}
