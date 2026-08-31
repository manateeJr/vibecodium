import { createFilesPanel } from './files.js';
import { createMachineHistory } from './machine-history.js';
import { createShareIntake } from './share-intake.js';
import { createSkillsPanel } from './skills.js';

// The four panels that hang off a session rather than drive one: the file browser, the machine
// transcript reader, the share landing, and the skill library. They were wired inline in app.js,
// which composes the whole shell and had no room left for another surface.
//
// They are built together because the share landing stages its files through the file browser, so
// the two have to be constructed in that order — which is exactly why this is one module and not
// four call sites.
export function createToolPanels({
  client,
  connection,
  elements,
  projectManager,
  errorMessage,
  onError,
  note,
  getEntry,
  getSessionId,
  stageAttachments,
  stageNote,
  render,
  closeDrawers,
  onPresetsChange,
  onPrompt,
}) {
  const files = createFilesPanel({
    client,
    elements,
    errorMessage,
    onError,
    note,
    getSessionId,
    attachPaths: stageAttachments,
    onOpen: closeDrawers,
  });
  const machineHistory = createMachineHistory({ connection, getEntry, render, errorMessage });
  const shareIntake = createShareIntake({
    connection,
    elements,
    projectManager,
    attachPaths: (paths) => files.attachPaths(paths),
    stageNote,
    onError,
    errorMessage,
  });
  const skills = createSkillsPanel({
    client,
    elements,
    errorMessage,
    onError,
    getProject: () => projectManager.selectedProject(),
    onPresetsChange,
    onPrompt,
  });
  return { files, machineHistory, shareIntake, skills };
}
