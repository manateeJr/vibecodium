// Three ways the main column can be filled, and only ever one of them at a time: the cold-start
// home when no session is selected, the structured transcript, and the read-only PTY mirror. The
// persistent two-button view-tabs strip that used to switch the last two is gone — the mirror is a
// toggle in the active-session chip menu, and the transcript is full-bleed by default.
export function createSessionView({ homePanel, structuredPanel, mirrorPanel, mirror }) {
  let home = false;
  let mirrorOpen = false;

  const apply = () => {
    homePanel.hidden = !home;
    structuredPanel.hidden = home || mirrorOpen;
    mirrorPanel.hidden = home || !mirrorOpen;
    mirror.setVisible(!home && mirrorOpen);
  };

  apply();

  return {
    selectSession(sessionId) {
      mirror.selectSession(sessionId);
    },
    setHome(next) {
      home = next;
      apply();
    },
    toggleMirror() {
      mirrorOpen = !mirrorOpen;
      apply();
    },
    mirrorVisible: () => mirrorOpen && !home,
  };
}
