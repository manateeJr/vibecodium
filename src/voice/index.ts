import { COMMAND_NAMES } from '../contracts/commands.js';
import type { Subsystem } from '../contracts/subsystem.js';

export function createVoiceSubsystem(): Subsystem {
  return {
    name: 'voice',
    register(context) {
      context.registerCommand(COMMAND_NAMES.voiceTranscribe, () => {
        throw new Error('voice.transcribe not implemented');
      });
    },
  };
}
