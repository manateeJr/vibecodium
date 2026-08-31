// Connectivity lifecycle: online/offline status and the PWA focus path. On visibilitychange to
// visible we force-reconnect every subscription (retaining cursors, so missed events replay),
// rehydrate the selected stream, and ask the service worker to check for a newer shell —
// the trio that keeps an installed PWA from ever showing a stale transcript (#50).
export function createObservedWebSocket({ onOpen, onDisconnect }) {
  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket !== 'function') return undefined;
  return class ObservedWebSocket extends NativeWebSocket {
    constructor(url) {
      super(url);
      let unavailableReported = false;
      const reportOpen = () => {
        unavailableReported = false;
        onOpen();
      };
      const reportUnavailable = () => {
        if (unavailableReported) return;
        unavailableReported = true;
        onDisconnect();
      };
      this.addEventListener('open', reportOpen);
      this.addEventListener('error', reportUnavailable);
      this.addEventListener('close', reportUnavailable);
    }
  };
}
export function createConnectionMonitor(setStatus, getSelected, onReady) {
  return createObservedWebSocket({
    onOpen: () => {
      if (!browserOnline()) {
        setStatus('OFFLINE', 'bad');
        return;
      }
      const selected = getSelected();
      setStatus(selected ? 'LIVE' : 'READY', selected ? 'live' : 'idle');
      void onReady?.();
    },
    onDisconnect: () => {
      const online = browserOnline();
      setStatus(online ? 'RECONNECTING' : 'OFFLINE', online ? 'wait' : 'bad');
    },
  });
}

function browserOnline() {
  return globalThis.navigator?.onLine !== false;
}

export function wireConnectivity({ setStatus, getSelected, hydrate, reconnect }) {
  globalThis.addEventListener('online', () => {
    setStatus('RECONNECTING', 'wait');
    reconnect();
    const selected = getSelected();
    if (selected) void hydrate(selected);
  });
  globalThis.addEventListener('offline', () => setStatus('OFFLINE', 'bad'));
  // Must listen on document: Window visibilitychange listeners do not fire on iOS PWAs.
  globalThis.document.addEventListener('visibilitychange', () => {
    if (globalThis.document.visibilityState !== 'visible') return;
    if (browserOnline()) setStatus('RECONNECTING', 'wait');
    reconnect();
    const selected = getSelected();
    if (selected) void hydrate(selected);
    void globalThis.navigator.serviceWorker?.ready
      .then((registration) => registration.update())
      .catch(() => undefined);
  });
}
