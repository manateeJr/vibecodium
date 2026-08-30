// Connectivity lifecycle: online/offline status and the PWA focus path. On visibilitychange to
// visible we force-reconnect every subscription (retaining cursors, so missed events replay),
// rehydrate the selected stream, and ask the service worker to check for a newer shell —
// the trio that keeps an installed PWA from ever showing a stale transcript (#50).
export function wireConnectivity({ setStatus, getSelected, hydrate, reconnect }) {
  globalThis.addEventListener('online', () => {
    const selected = getSelected();
    setStatus(selected ? 'LIVE' : 'READY', selected ? 'live' : 'idle');
    if (selected) void hydrate(selected);
  });
  globalThis.addEventListener('offline', () => setStatus('OFFLINE', 'bad'));
  // Must listen on document: Window visibilitychange listeners do not fire on iOS PWAs.
  globalThis.document.addEventListener('visibilitychange', () => {
    if (globalThis.document.visibilityState !== 'visible') return;
    reconnect();
    const selected = getSelected();
    if (selected) void hydrate(selected);
    void globalThis.navigator.serviceWorker?.ready
      .then((registration) => registration.update())
      .catch(() => undefined);
  });
}
