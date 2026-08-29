import os from 'node:os';
import {
  COMMAND_NAMES,
  type HostSetSessionCapArgs,
  type HostSetSessionCapResult,
  type HostStatsResult,
  type MachineListResult,
} from '../contracts/commands.js';
import type { EventEnvelope, EventKind } from '../contracts/events.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { createMachineSessionsSubsystem } from '../machine-sessions/index.js';
import {
  admissionConfigFromEnv,
  effectiveMaxConcurrent,
  persistMaxConcurrent,
} from '../session/admission.js';

export interface HostSubsystemOptions {
  readonly machineList?: () => Promise<MachineListResult>;
  readonly system?: Pick<typeof os, 'totalmem' | 'freemem' | 'loadavg' | 'uptime'>;
}

export class HostSubsystem implements Subsystem {
  public readonly name = 'host';
  private readonly machineList: () => Promise<MachineListResult>;
  private readonly system: Pick<typeof os, 'totalmem' | 'freemem' | 'loadavg' | 'uptime'>;
  private readonly activeSessionIds = new Set<string>();
  private registered = false;

  public constructor(options: HostSubsystemOptions = {}) {
    const machineSessions = createMachineSessionsSubsystem();
    this.machineList = options.machineList ?? (() => machineSessions.list());
    this.system = options.system ?? os;
  }

  public register(context: SubsystemContext): void {
    if (this.registered) throw new Error('host subsystem is already registered');
    this.registered = true;
    context.subscribe(0, (event) => this.observe(event));
    context.registerCommand(COMMAND_NAMES.hostStats, () => this.stats());
    context.registerCommand(COMMAND_NAMES.hostSetSessionCap, (command: unknown) =>
      this.setSessionCap(command),
    );
  }

  public async stats(): Promise<HostStatsResult> {
    const mem_total = this.system.totalmem();
    const mem_used = Math.max(0, mem_total - this.system.freemem());
    const machine = await this.machineList();
    return {
      mem_total,
      mem_used,
      load: this.system.loadavg(),
      uptime_seconds: this.system.uptime(),
      vibecodium_sessions: this.activeSessionIds.size,
      global_sessions: machine.sessions.length,
      max_concurrent: effectiveMaxConcurrent(admissionConfigFromEnv().maxConcurrent),
    };
  }

  public setSessionCap(command: unknown): HostSetSessionCapResult {
    const args = hostSetSessionCapArgs(command);
    persistMaxConcurrent(args.max_concurrent);
    return { max_concurrent: args.max_concurrent };
  }

  private observe(event: EventEnvelope<EventKind>): void {
    if (event.type !== 'session_started' && event.type !== 'session_complete') return;
    const sessionId = sessionIdFromPayload(event.payload);
    if (!sessionId) return;
    if (event.type === 'session_started') this.activeSessionIds.add(sessionId);
    else this.activeSessionIds.delete(sessionId);
  }
}

export function createHostSubsystem(options: HostSubsystemOptions = {}): HostSubsystem {
  return new HostSubsystem(options);
}
function hostSetSessionCapArgs(command: unknown): HostSetSessionCapArgs {
  let maxConcurrent: unknown;
  if (
    command !== null &&
    typeof command === 'object' &&
    !Array.isArray(command) &&
    'max_concurrent' in command
  ) {
    maxConcurrent = command.max_concurrent;
  }
  if (
    typeof maxConcurrent !== 'number' ||
    !Number.isSafeInteger(maxConcurrent) ||
    maxConcurrent <= 0
  )
    throw new Error('max_concurrent must be a positive integer');
  return { max_concurrent: maxConcurrent };
}

function sessionIdFromPayload(payload: unknown): string | undefined {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('session_id' in payload)
  )
    return undefined;
  const sessionId = payload.session_id;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}
