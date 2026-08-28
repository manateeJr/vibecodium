import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { WorkflowEngine, type WorkflowEngineOptions } from './engine.js';

export * from './engine.js';
export * from './podman.js';
export * from './templates.js';

export function register(ctx: SubsystemContext): void {
  new WorkflowEngine(ctx).register();
}

export function createWorkflowSubsystem(options: WorkflowEngineOptions = {}): Subsystem {
  return {
    name: 'workflow',
    register(ctx) {
      new WorkflowEngine(ctx, options).register();
    },
  };
}
