import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { createNotifySubsystem } from '../notify/index.js';
import { createSessionSubsystem } from '../session/index.js';
import { createWorkspaceSubsystem } from '../workspace/index.js';

import { createTelemetrySubsystem } from '../telemetry/index.js';
import { createWorkflowSubsystem } from '../workflow/index.js';

export function registerSubsystems(
  context: SubsystemContext,
  subsystems?: readonly Subsystem[],
): readonly Subsystem[] {
  const selected = subsystems ?? [
    createTelemetrySubsystem(),
    createWorkflowSubsystem(),
    createNotifySubsystem(),
    createSessionSubsystem(),
    createWorkspaceSubsystem(),
  ];
  for (const subsystem of selected) subsystem.register(context);
  return selected;
}
