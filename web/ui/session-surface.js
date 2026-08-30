import { createPtyMirror } from './pty-mirror.js';
import { createSessionView } from './session-view.js';
import { createTranscriptView } from './transcript.js';

// One seam for the two ways to watch a session: the structured transcript and the read-only live
// PTY mirror. Composed here so app.js only wires the surface once.
//
// `connection` is read lazily on every subscribe, so a token saved in Settings applies to the next
// mirror without rebuilding the surface.
export function createSessionSurface({ connection, elements, onSteerNow }) {
  const transcript = createTranscriptView({
    streamLines: elements.streamLines,
    streamEmpty: elements.streamEmpty,
    jumpLatest: elements.jumpLatest,
    onSteerNow,
  });
  const mirror = createPtyMirror({
    connection,
    terminalTarget: elements.ptyTerminal,
    empty: elements.ptyMirrorEmpty,
    status: elements.mirrorStatus,
  });
  const sessionView = createSessionView({
    structuredTab: elements.structuredViewTab,
    mirrorTab: elements.mirrorViewTab,
    structuredPanel: elements.structuredView,
    mirrorPanel: elements.mirrorView,
    mirror,
  });
  return { transcript, sessionView };
}
