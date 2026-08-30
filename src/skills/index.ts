import { COMMAND_NAMES } from '../contracts/commands.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';

export class SkillsSubsystem implements Subsystem {
  public readonly name = 'skills';

  public register(context: SubsystemContext): void {
    context.registerCommand(COMMAND_NAMES.skillList, () => {
      throw new Error('skill.list not implemented');
    });
    context.registerCommand(COMMAND_NAMES.skillDraft, () => {
      throw new Error('skill.draft not implemented');
    });
    context.registerCommand(COMMAND_NAMES.skillSave, () => {
      throw new Error('skill.save not implemented');
    });
    context.registerCommand(COMMAND_NAMES.skillRemove, () => {
      throw new Error('skill.remove not implemented');
    });
    context.registerCommand(COMMAND_NAMES.skillAdopt, () => {
      throw new Error('skill.adopt not implemented');
    });
    context.registerCommand(COMMAND_NAMES.skillPropose, () => {
      throw new Error('skill.propose not implemented');
    });
    context.registerCommand(COMMAND_NAMES.skillInvoke, () => {
      throw new Error('skill.invoke not implemented');
    });
  }
}

export function createSkillsSubsystem(): SkillsSubsystem {
  return new SkillsSubsystem();
}
