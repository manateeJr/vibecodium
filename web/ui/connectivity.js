// Connectivity lifecycle: online/offline status, honest HTTP health, and the PWA focus path.
const CONNECTION_LABELS = new Set(['LIVE', 'READY', 'RECONNECTING', 'OFFLINE']);
const DEFAULT_HEALTH_INTERVAL_MS = 7_500;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const MAX_HEALTH_INTERVAL_MS = 30_000;

export function classifyHealth({ response, error, timedOut = false }) {
  if (timedOut || error?.name === 'AbortError') return 'wedged';
  if (error) return 'down';
  if (!response || response.status !== 200 || response.ok !== true) return 'wedged';
  return 'healthy';
}

export function deriveStatus({
  health = 'unknown',
  selected = false,
  online = true,
  reconnecting = false,
}) {
  if (health === 'down') return { label: 'DOWN', tone: 'bad' };
  if (health === 'wedged') return { label: 'WEDGED', tone: 'bad' };
  if (!online) return { label: 'OFFLINE', tone: 'bad' };
  if (reconnecting) return { label: 'RECONNECTING', tone: 'wait' };
  return selected ? { label: 'LIVE', tone: 'live' } : { label: 'READY', tone: 'idle' };
}

export function createStatusController(elements, getSelected, { isOnline = browserOnline } = {}) {
  let health = 'unknown';
  let mode = 'connection';
  let reconnecting = false;
  let onlineOverride;

  const effectiveOnline = () => onlineOverride !== false && isOnline();
  const render = ({ label, tone }) => {
    elements.status.textContent = label;
    elements.connection.dataset.tone = tone;
  };
  const renderConnection = () =>
    render(
      deriveStatus({
        health,
        selected: Boolean(getSelected()),
        online: effectiveOnline(),
        reconnecting,
      }),
    );

  const setStatus = (label, tone) => {
    if (label === 'OFFLINE') onlineOverride = false;
    else if (label === 'RECONNECTING') onlineOverride = true;
    else if (label === 'LIVE' || label === 'READY') onlineOverride = undefined;
    if (health === 'down' || health === 'wedged' || !effectiveOnline()) {
      mode = 'connection';
      reconnecting = label === 'RECONNECTING';
      renderConnection();
      return;
    }
    if (CONNECTION_LABELS.has(label)) {
      mode = 'connection';
      reconnecting = label === 'RECONNECTING';
      renderConnection();
      return;
    }
    mode = 'message';
    render({ label, tone });
  };
  const setHealth = (nextHealth) => {
    health = nextHealth;
    if (nextHealth === 'down' || nextHealth === 'wedged') mode = 'connection';
    if (mode === 'connection') renderConnection();
  };

  return { setStatus, setHealth };
}

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

export function createHealthMonitor({
  baseUrl = globalThis.location?.origin ?? '',
  onState,
  fetchImpl = globalThis.fetch,
  intervalMs = DEFAULT_HEALTH_INTERVAL_MS,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  maxIntervalMs = MAX_HEALTH_INTERVAL_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  AbortControllerImpl = globalThis.AbortController,
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/healthz`;
  const cappedInterval = Math.max(intervalMs, maxIntervalMs);
  let state = 'unknown';
  let failures = 0;
  let timer;
  let controller;
  let inFlight = false;
  let stopped = false;

  const notify = (nextState) => {
    state = nextState;
    onState?.(nextState);
  };
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    const delay =
      state === 'healthy'
        ? intervalMs
        : Math.min(cappedInterval, intervalMs * 2 ** Math.min(failures, 2));
    timer = setTimeoutImpl(() => {
      timer = undefined;
      void check();
    }, delay);
  };
  const check = async () => {
    if (stopped || inFlight) return state;
    if (timer !== undefined) {
      clearTimeoutImpl(timer);
      timer = undefined;
    }
    inFlight = true;
    let timedOut = false;
    let timeoutTimer;
    controller = typeof AbortControllerImpl === 'function' ? new AbortControllerImpl() : undefined;
    try {
      if (!controller || typeof fetchImpl !== 'function') {
        notify(!controller ? 'wedged' : 'down');
      } else {
        const timeout = new Promise((_, reject) => {
          timeoutTimer = setTimeoutImpl(() => {
            timedOut = true;
            controller?.abort();
            reject(new Error('health check timeout'));
          }, timeoutMs);
        });
        const response = await Promise.race([
          fetchImpl(endpoint, {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal,
          }),
          timeout,
        ]);
        notify(classifyHealth({ response, timedOut }));
      }
    } catch (error) {
      if (!stopped) notify(classifyHealth({ error, timedOut }));
    } finally {
      if (timeoutTimer !== undefined) clearTimeoutImpl(timeoutTimer);
      controller = undefined;
      inFlight = false;
      failures = state === 'healthy' ? 0 : failures + 1;
      schedule();
    }
    return state;
  };
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeoutImpl(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  };

  void check();
  return {
    check,
    stop,
    get state() {
      return state;
    },
  };
}

function browserOnline() {
  return globalThis.navigator?.onLine !== false;
}

export function wireConnectivity({
  setStatus,
  getSelected,
  hydrate,
  reconnect,
  reload,
  eventTarget = globalThis,
  documentTarget = globalThis.document,
  isOnline = browserOnline,
  serviceWorker = globalThis.navigator?.serviceWorker,
}) {
  const reconnectAndReload = () => {
    reconnect();
    const selected = getSelected();
    if (selected) void hydrate(selected);
    void reload?.();
  };
  eventTarget.addEventListener('online', () => {
    setStatus('RECONNECTING', 'wait');
    reconnectAndReload();
  });
  eventTarget.addEventListener('offline', () => setStatus('OFFLINE', 'bad'));
  // Must listen on document: Window visibilitychange listeners do not fire on iOS PWAs.
  documentTarget?.addEventListener('visibilitychange', () => {
    if (documentTarget.visibilityState !== 'visible') return;
    const online = isOnline();
    setStatus(online ? 'RECONNECTING' : 'OFFLINE', online ? 'wait' : 'bad');
    reconnectAndReload();
    void serviceWorker?.ready?.then((registration) => registration.update()).catch(() => undefined);
  });
}
