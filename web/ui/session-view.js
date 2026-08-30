export function createSessionView({
  structuredTab,
  mirrorTab,
  structuredPanel,
  mirrorPanel,
  mirror,
}) {
  const setView = (nextView) => {
    const showingMirror = nextView === 'mirror';
    structuredPanel.hidden = showingMirror;
    mirrorPanel.hidden = !showingMirror;
    structuredTab.setAttribute('aria-selected', String(!showingMirror));
    mirrorTab.setAttribute('aria-selected', String(showingMirror));
    mirror.setVisible(showingMirror);
  };

  structuredTab.addEventListener('click', () => setView('structured'));
  mirrorTab.addEventListener('click', () => setView('mirror'));
  setView('structured');

  return {
    selectSession(sessionId) {
      mirror.selectSession(sessionId);
    },
  };
}
