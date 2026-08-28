import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { createNotifySubsystem } from '../notify/index.js';
import { createTelemetrySubsystem } from '../telemetry/index.js';
import { createWorkflowSubsystem } from '../workflow/index.js';

export function registerSubsystems(
  context: SubsystemContext,
  subsystems: readonly Subsystem[] = [
    createTelemetrySubsystem(),
    createWorkflowSubsystem(),
    createNotifySubsystem(),
  ],
): void {
  for (const subsystem of subsystems) subsystem.register(context);
}
