/* global self */

// Bumped by hand with every shell change: the assets are served straight off disk with no build
// step, so there is no content hash or build stamp to derive a cache name from. Changing this is
// what makes install/activate replace the old shell — see web/ui/updates.js for the page's half.
const CACHE_NAME = 'vibecodium-shell-v15';
// The share_target the manifest declares POSTs here. The fetch handler below turns that POST into
// the `/?share=<token>` navigation the app knows how to land on.
const SHARE_INTAKE_PATH = '/share-intake';
const SHELL_ASSETS = Object.freeze([
  '/',
  '/index.html',
  '/app.js',
  '/pocket.css',
  '/compose.css',
  '/ui.css',
  '/layout.css',
  '/panels.css',
  '/drawers.css',
  '/surface.css',
  '/transcript-stream.css',
  '/lib/base64.js',
  '/lib/command.js',
  '/lib/external-session.js',
  '/lib/machine-read.js',
  '/lib/markdown.js',
  '/lib/paths.js',
  '/lib/pty-socket.js',
  '/lib/session-entries.js',
  '/lib/session-items.js',
  '/lib/session-state.js',
  '/lib/skills.js',
  '/lib/storage.js',
  '/lib/time.js',
  '/ui/actions.js',
  '/ui/compose-controls.js',
  '/ui/composer.js',
  '/ui/drawers.js',
  '/ui/elements.js',
  '/ui/event-feed.js',
  '/ui/events.js',
  '/ui/external-hint.js',
  '/ui/files.js',
  '/ui/git-status.js',
  '/ui/history-row.js',
  '/ui/home-view.js',
  '/ui/host-panel.js',
  '/ui/machine-history.js',
  '/ui/model-picker.js',
  '/ui/project-manager.js',
  '/ui/restart-action.js',
  '/ui/session-chip.js',
  '/ui/share-intake.js',
  '/ui/stream-log.js',
  '/ui/skill-builder.js',
  '/ui/skills.js',
  '/ui/transcript.js',
  '/ui/connectivity.js',
  '/ui/pty-mirror.js',
  '/ui/session-surface.js',
  '/ui/session-view.js',
  '/ui/updates.js',
  '/ui/voice.js',
  // xterm.js is a vendored static asset, never an npm dependency. See web/vendor/xterm/README.md.
  '/vendor/xterm/xterm.js',
  '/vendor/xterm/xterm.css',
  // Not a file on disk: the control plane serves /tokens.css from src/design/tokens.ts. It is
  // precached like any other shell asset, because without it the offline shell has no palette.
  '/tokens.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/favicon.ico',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    globalThis.caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    globalThis.caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('vibecodium-shell-') && name !== CACHE_NAME)
            .map((name) => globalThis.caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new globalThis.URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Android's share_target navigates by POSTing the shared files here. Left alone that navigation
  // would land the operator on the intake route's JSON body, so it is exchanged for a token and
  // redirected into the app. Only a navigation is taken: a programmatic POST to the same route is
  // somebody's own upload and stays theirs.
  if (
    request.method === 'POST' &&
    request.mode === 'navigate' &&
    url.pathname === SHARE_INTAKE_PATH
  ) {
    event.respondWith(stageShare(request));
    return;
  }
  if (request.method !== 'GET') return;

  if (isControlPlanePath(url.pathname)) {
    event.respondWith(globalThis.fetch(request));
    return;
  }
  if (request.mode === 'navigate' || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// The intake route answers `{ token, path }`; `value` is unwrapped too because the control plane
// wraps command results that way and the route sits next to them.
async function stageShare(request) {
  try {
    const response = await globalThis.fetch(SHARE_INTAKE_PATH, {
      method: 'POST',
      body: await request.formData(),
    });
    const body = await response.json();
    const token = String(body?.token ?? body?.value?.token ?? '');
    if (!response.ok || token === '') throw new Error('share intake staged nothing');
    return landing(`share=${encodeURIComponent(token)}`);
  } catch {
    // The files are gone either way, so the operator is told rather than dropped on a blank app.
    return landing('share_error=upload');
  }
}

function landing(query) {
  return globalThis.Response.redirect(
    new globalThis.URL(`/?${query}`, self.location.origin).href,
    303,
  );
}

function isControlPlanePath(pathname) {
  return (
    pathname === '/events' ||
    pathname.startsWith('/events/') ||
    pathname === '/commands' ||
    pathname.startsWith('/commands/') ||
    pathname === '/healthz' ||
    pathname.startsWith('/api/')
  );
}

async function staleWhileRevalidate(request) {
  const cache = await globalThis.caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = globalThis
    .fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  const response = cached ?? (await network);
  if (response) return response;
  const fallback = await cache.match('/index.html');
  if (fallback) return fallback;
  return new globalThis.Response('Vibecodium is offline.', {
    status: 503,
    headers: { 'content-type': 'text/plain' },
  });
}
