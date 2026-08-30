/* global self */

// Bumped by hand with every shell change: the assets are served straight off disk with no build
// step, so there is no content hash or build stamp to derive a cache name from. Changing this is
// what makes install/activate replace the old shell — see web/ui/updates.js for the page's half.
const CACHE_NAME = 'vibecodium-shell-v13';
const SHELL_ASSETS = Object.freeze([
  '/',
  '/index.html',
  '/app.js',
  '/pocket.css',
  '/compose.css',
  '/ui.css',
  '/layout.css',
  '/panels.css',
  '/surface.css',
  '/lib/base64.js',
  '/lib/command.js',
  '/lib/external-session.js',
  '/lib/markdown.js',
  '/lib/paths.js',
  '/lib/pty-socket.js',
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
  '/ui/files.js',
  '/ui/git-status.js',
  '/ui/host-panel.js',
  '/ui/model-picker.js',
  '/ui/project-manager.js',
  '/ui/session-bar.js',
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
  if (request.method !== 'GET') return;

  const url = new globalThis.URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isControlPlanePath(url.pathname)) {
    event.respondWith(globalThis.fetch(request));
    return;
  }
  if (request.mode === 'navigate' || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

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
