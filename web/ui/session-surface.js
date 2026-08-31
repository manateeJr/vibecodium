import { createHomeView } from './home-view.js';
import { createPtyMirror } from './pty-mirror.js';
import { createSessionChip } from './session-chip.js';
import { createSessionView } from './session-view.js';
import { createTranscriptView } from './transcript.js';

// Everything the main column can show, and the one control that drives it, composed here so app.js
// wires the surface once: the cold-start home, the structured transcript, the read-only PTY mirror,
// and the active-session chip whose menu carries rename, stop and the live-mirror toggle.
//
// `connection` is read lazily on every subscribe and every request, so a token saved in Settings
// applies to the next mirror and the next home refresh without rebuilding the surface.
export function createSessionSurface({
  connection,
  elements,
  onSteerNow,
  onRename,
  onStop,
  onSelectRecent,
  onError,
  errorMessage,
}) {
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
    homePanel: elements.homeView,
    structuredPanel: elements.structuredView,
    mirrorPanel: elements.mirrorView,
    mirror,
  });
  const home = createHomeView({
    list: elements.homeRecent,
    connection,
    onSelect: onSelectRecent,
    onError,
    errorMessage,
  });
  const chip = createSessionChip({
    button: elements.sessionChip,
    label: elements.sessionChipLabel,
    dot: elements.sessionChipDot,
    menu: elements.sessionMenu,
    onRename,
    onStop,
    onToggleMirror: () => sessionView.toggleMirror(),
    isMirrorVisible: () => sessionView.mirrorVisible(),
  });
  return { transcript, sessionView, home, chip };
}
