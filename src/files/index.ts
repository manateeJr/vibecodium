import { COMMAND_NAMES } from '../contracts/commands.js';
import type { Subsystem, SubsystemContext } from '../contracts/subsystem.js';

export class FilesSubsystem implements Subsystem {
  public readonly name = 'files';

  public register(context: SubsystemContext): void {
    context.registerCommand(COMMAND_NAMES.filesList, () => {
      throw new Error('files.list not implemented');
    });
    context.registerCommand(COMMAND_NAMES.filesDownload, () => {
      throw new Error('files.download not implemented');
    });
    context.registerCommand(COMMAND_NAMES.filesUpload, () => {
      throw new Error('files.upload not implemented');
    });
    context.registerCommand(COMMAND_NAMES.filesSharedDir, () => {
      throw new Error('files.shared_dir not implemented');
    });
  }
}

export function createFilesSubsystem(): FilesSubsystem {
  return new FilesSubsystem();
}
