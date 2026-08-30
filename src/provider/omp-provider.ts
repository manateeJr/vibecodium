import type {
  ProviderCapabilityMatrix,
  ProviderSession,
  ProviderSpawnRequest,
} from '../contracts/provider-contract.js';
import { ompHarnessPlugin } from './omp-harness-plugin.js';
import { CliProvider, type CliProviderOptions } from './cli-provider.js';
export class OmpProvider extends CliProvider {
  public readonly name = 'omp';
  public readonly persistent = true;
  public readonly harnessPlugin = ompHarnessPlugin;
  private readonly resumedRefs = new Map<string, string>();

  public constructor(options: CliProviderOptions = {}) {
    super('omp', options);
  }

  public override async spawn(request: ProviderSpawnRequest): Promise<ProviderSession> {
    if (request.resumeRef) this.resumedRefs.set(request.sessionId, request.resumeRef);
    return super.spawn(request);
  }

  protected commandArgs(request: ProviderSpawnRequest): string[] {
    const args = ['--print', '--mode', 'text'];
    if (request.storageDir) args.push('--session-dir', request.storageDir);
    const resumeRef =
      request.resumeRef ?? (request.resume ? this.resumedRefs.get(request.sessionId) : undefined);
    if (resumeRef) args.push('--resume', resumeRef);
    else if (request.resume) args.push('--continue');
    args.push('--', request.prompt);
    return args;
  }
  public capabilityMatrix(): ProviderCapabilityMatrix {
    return {
      provider: this.name,
      streaming: true,
      stop: true,
      models: ['configured'],
      persistent: true,
    };
  }
}
