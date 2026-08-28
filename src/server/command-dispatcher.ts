import { COMMAND_NAMES, WORKFLOW_START_COMMAND } from '../contracts/commands.js';
import type { CapabilityTokenClaims, CapabilityTokenManager } from '../notify/index.js';
import type { CommandHandler, Subsystem } from '../contracts/subsystem.js';
import type { CommandTokenVerifier } from './control-plane.js';

export class CommandAuthorizationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CommandAuthorizationError';
  }
}

export class CommandDispatcher {
  private readonly commands: Map<string, CommandHandler>;
  private readonly tokenVerifier: CommandTokenVerifier | undefined;

  public constructor(
    commands: Map<string, CommandHandler>,
    tokenVerifier: CommandTokenVerifier | undefined,
  ) {
    this.commands = commands;
    this.tokenVerifier = tokenVerifier;
  }
  public registerWorkflowRun(): void {
    const start = this.commands.get(WORKFLOW_START_COMMAND);
    if (!start || this.commands.has(COMMAND_NAMES.workflowRun)) return;
    this.commands.set(COMMAND_NAMES.workflowRun, async (command) => {
      const args = workflowRunArgs(command);
      const result = await start(args);
      const workflowId = asRecord(result)?.workflow_id;
      if (typeof workflowId !== 'string' || !workflowId.trim())
        throw new Error('workflow.start did not return workflow_id');
      return { stream_id: `workflow:${workflowId}` };
    });
  }

  public async dispatch(
    name: string,
    args: unknown,
    providedToken: string | undefined,
    remoteAddress: string | undefined,
  ): Promise<unknown> {
    const handler = this.commands.get(name);
    if (!handler) throw new Error(`unknown command: ${name}`);
    const claims = this.authorize(name, args, providedToken, remoteAddress);
    return handler(normalizeCommand(name, args, claims));
  }

  public verifyToken(token: string | undefined): boolean {
    if (!token) return false;
    return this.tokenVerifier?.verify(token) !== undefined;
  }

  private authorize(
    name: string,
    args: unknown,
    providedToken: string | undefined,
    remoteAddress: string | undefined,
  ): CapabilityTokenClaims | undefined {
    const token = providedToken ?? commandToken(args);
    if (name === COMMAND_NAMES.workflowApprove) {
      if (!token) {
        if (isLoopbackAddress(remoteAddress)) return undefined;
        throw new CommandAuthorizationError('approval token is required');
      }
      const claims = this.tokenVerifier?.consume(token);
      if (!claims) throw new CommandAuthorizationError('invalid, expired, or replayed token');
      return claims;
    }
    if (isLoopbackAddress(remoteAddress)) return undefined;
    if (!token) throw new CommandAuthorizationError('authorization token is required');
    const claims = this.tokenVerifier?.verify(token);
    if (!claims) throw new CommandAuthorizationError('invalid or expired authorization token');
    return claims;
  }
}

export function capabilityVerifierFrom(
  subsystems: readonly Subsystem[],
): CommandTokenVerifier | undefined {
  const notify = subsystems.find((subsystem) => subsystem.name === 'notify');
  if (!notify || !('capabilityTokens' in notify)) return undefined;
  const candidate = (notify as { capabilityTokens?: unknown }).capabilityTokens;
  if (!isTokenVerifier(candidate)) return undefined;
  return candidate;
}

export function sessionStopHandlersFrom(subsystems: readonly Subsystem[]): readonly (() => void)[] {
  const handlers: Array<() => void> = [];
  for (const subsystem of subsystems) {
    if (subsystem.name !== 'session' || !('stopAll' in subsystem)) continue;
    const stopAll = (subsystem as { stopAll?: unknown }).stopAll;
    if (typeof stopAll === 'function') handlers.push(() => stopAll.call(subsystem));
  }
  return handlers;
}

function normalizeCommand(
  name: string,
  args: unknown,
  claims: CapabilityTokenClaims | undefined,
): unknown {
  if (name !== COMMAND_NAMES.workflowApprove) return args;
  const value = asRecord(args) ?? {};
  const workflowId = workflowIdFrom(value, claims);
  return {
    ...value,
    workflow_id: workflowId,
    ...(value.request_id === undefined && claims ? { request_id: claims.request_id } : {}),
  };
}

function workflowRunArgs(command: unknown): Readonly<Record<string, unknown>> {
  const value = asRecord(command);
  if (!value || typeof value.template !== 'string' || !value.template.trim())
    throw new Error('template is required');
  return value;
}

function workflowIdFrom(
  value: Record<string, unknown>,
  claims: CapabilityTokenClaims | undefined,
): string {
  if (typeof value.workflow_id === 'string' && value.workflow_id.trim()) return value.workflow_id;
  if (typeof value.stream_id === 'string' && value.stream_id.trim()) {
    return value.stream_id.startsWith('workflow:')
      ? value.stream_id.slice('workflow:'.length)
      : value.stream_id;
  }
  const workflowId = claims?.scope.workflow_id;
  if (workflowId && workflowId.trim()) return workflowId;
  throw new Error('stream_id or workflow_id is required');
}

function commandToken(args: unknown): string | undefined {
  const value = asRecord(args);
  return typeof value?.token === 'string' && value.token.trim() ? value.token : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isTokenVerifier(
  value: unknown,
): value is Pick<CapabilityTokenManager, 'verify' | 'consume'> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.verify === 'function' && typeof candidate.consume === 'function';
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return true;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
