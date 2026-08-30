// The service worker owns the shell, so a new build only reaches the operator when a new worker
// activates. sw.js calls skipWaiting/clients.claim, which means the new worker takes over every
// request the moment it installs — but this page is still running the modules it loaded from the
// old one. Reloading behind the operator's back would eat whatever they were typing, so the new
// build is announced instead and the reload is theirs to tap.
//
// The first install is not an update: there was no controller to replace, and the page it just
// claimed is already the new build. That is the one case the affordance must stay silent for.
export function wireServiceWorkerUpdates({ button }) {
  const serviceWorker = globalThis.navigator.serviceWorker;
  if (!serviceWorker) return;
  const controlledAtLoad = Boolean(serviceWorker.controller);
  let reloading = false;

  const announce = () => {
    if (!controlledAtLoad || reloading) return;
    button.hidden = false;
  };

  button.addEventListener('click', () => {
    reloading = true;
    button.disabled = true;
    globalThis.location.reload();
  });
  serviceWorker.addEventListener('controllerchange', announce);
  // index.html registers the worker ahead of the module graph, so this only has to find it.
  void serviceWorker.ready
    .then((registration) => {
      // controllerchange is the reliable signal, but a worker that activates without claiming this
      // page — an older sw.js still in flight during the rollout — would otherwise pass unnoticed.
      watchIncoming(registration, announce);
      registration.addEventListener('updatefound', () => watchIncoming(registration, announce));
    })
    .catch(() => undefined);
}

function watchIncoming(registration, announce) {
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return;
  if (worker.state === 'activated') {
    announce();
    return;
  }
  worker.addEventListener('statechange', () => {
    if (worker.state === 'activated') announce();
  });
}
