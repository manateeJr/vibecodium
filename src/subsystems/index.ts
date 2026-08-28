import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';

const SUBSYSTEMS: readonly Subsystem[] = [];

export function registerSubsystems(
  context: SubsystemContext,
  subsystems: readonly Subsystem[] = SUBSYSTEMS,
): void {
  for (const subsystem of subsystems) subsystem.register(context);
}
