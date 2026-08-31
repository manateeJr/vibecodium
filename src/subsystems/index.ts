import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';
import type { SubstrateClient } from '../contracts/substrate-contract.js';
import { createSubstrateClient } from '../substrate/index.js';
import { SessionTable } from '../session/session-table.js';
import { createHostSubsystem } from '../host/index.js';
import { createMachineSessionsSubsystem } from '../machine-sessions/index.js';
import { createNotifySubsystem } from '../notify/index.js';
import { createVoiceSubsystem } from '../voice/index.js';
import { createSessionSubsystem } from '../session/index.js';
import { createWorkspaceSubsystem } from '../workspace/index.js';
import { createProjectsSubsystem } from '../projects/index.js';
import { createFilesSubsystem } from '../files/index.js';
import { createSkillsSubsystem } from '../skills/index.js';
import { createReportsSubsystem } from '../reports/index.js';

import { createTelemetrySubsystem } from '../telemetry/index.js';
import { createWorkflowSubsystem } from '../workflow/index.js';
export interface SubsystemRegistrationOptions {
  readonly substrate?: SubstrateClient;
  readonly sessionTable?: SessionTable;
  readonly sessionTableFilename?: string;
}

export function registerSubsystems(
  context: SubsystemContext,
  subsystems?: readonly Subsystem[],
  options: SubsystemRegistrationOptions = {},
): readonly Subsystem[] {
  const machineSessions = createMachineSessionsSubsystem();
  const sessions = createSessionSubsystem({
    machineSessions,
    substrate: options.substrate ?? createSubstrateClient(),
    sessionTable:
      options.sessionTable ??
      new SessionTable({ filename: options.sessionTableFilename ?? ':memory:' }),
  });
  const selected = subsystems ?? [
    createTelemetrySubsystem(),
    createWorkflowSubsystem(),
    createNotifySubsystem(),
    createHostSubsystem(),
    createVoiceSubsystem(),
    machineSessions,
    sessions,
    createWorkspaceSubsystem(),
    createProjectsSubsystem(),
    createFilesSubsystem(),
    createSkillsSubsystem(),
    createReportsSubsystem({ sessions }),
  ];
  for (const subsystem of selected) subsystem.register(context);
  return selected;
}
