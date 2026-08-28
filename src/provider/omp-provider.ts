import type {
  ProviderCapabilityMatrix,
  ProviderSpawnRequest,
} from '../contracts/provider-contract.js';
import { CliProvider, type CliProviderOptions } from './cli-provider.js';

export class OmpProvider extends CliProvider {
  public readonly name = 'omp';

  public constructor(options: CliProviderOptions = {}) {
    super('omp', options);
  }

  protected commandArgs(request: ProviderSpawnRequest): string[] {
    const args = ['--print', '--mode', 'text'];
    if (request.storageDir) args.push('--session-dir', request.storageDir);
    if (request.resume) args.push('--continue');
    args.push('--', request.prompt);
    return args;
  }

  public capabilityMatrix(): ProviderCapabilityMatrix {
    return {
      provider: this.name,
      streaming: true,
      stop: true,
      models: ['configured'],
    };
  }
}
