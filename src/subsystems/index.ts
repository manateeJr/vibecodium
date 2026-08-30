import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import { createHostSubsystem } from '../host/index.js';
import { createMachineSessionsSubsystem } from '../machine-sessions/index.js';
import { createNotifySubsystem } from '../notify/index.js';
import { createVoiceSubsystem } from '../voice/index.js';
import { createSessionSubsystem } from '../session/index.js';
import { createWorkspaceSubsystem } from '../workspace/index.js';
import { createProjectsSubsystem } from '../projects/index.js';
import { createFilesSubsystem } from '../files/index.js';
import { createSkillsSubsystem } from '../skills/index.js';

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
    createHostSubsystem(),
    createVoiceSubsystem(),
    createMachineSessionsSubsystem(),
    createSessionSubsystem(),
    createWorkspaceSubsystem(),
    createProjectsSubsystem(),
    createFilesSubsystem(),
    createSkillsSubsystem(),
  ];
  for (const subsystem of selected) subsystem.register(context);
  return selected;
}
