import { COMMAND_NAMES } from '../contracts/commands.js';
import type { Subsystem } from '../contracts/subsystem.js';

export function createHostSubsystem(): Subsystem {
  return {
    name: 'host',
    register(context) {
      context.registerCommand(COMMAND_NAMES.hostStats, () => {
        throw new Error('host.stats not implemented');
      });
      context.registerCommand(COMMAND_NAMES.hostSetSessionCap, () => {
        throw new Error('host.set_session_cap not implemented');
      });
    },
  };
}
