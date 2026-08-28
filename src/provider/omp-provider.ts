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
    return ['--print', '--mode', 'text', '--no-session', '--', request.prompt];
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
