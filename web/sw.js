/* global self */

const CACHE_NAME = 'vibecodium-shell-v10';
const SHELL_ASSETS = Object.freeze([
  '/',
  '/index.html',
  '/app.js',
  '/pocket.css',
  '/ui.css',
  '/layout.css',
  '/panels.css',
  '/surface.css',
  '/lib/base64.js',
  '/lib/external-session.js',
  '/lib/markdown.js',
  '/lib/paths.js',
  '/lib/session-items.js',
  '/lib/session-state.js',
  '/lib/skills.js',
  '/lib/storage.js',
  '/lib/time.js',
  '/ui/actions.js',
  '/ui/drawers.js',
  '/ui/elements.js',
  '/ui/events.js',
  '/ui/files.js',
  '/ui/git-status.js',
  '/ui/host-panel.js',
  '/ui/project-manager.js',
  '/ui/session-bar.js',
  '/ui/skill-builder.js',
  '/ui/skills.js',
  '/ui/transcript.js',
  '/ui/pty-mirror.js',
  '/ui/session-surface.js',
  '/ui/session-view.js',
  '/ui/voice.js',
  // xterm.js is a vendored static asset, never an npm dependency. See web/vendor/xterm/README.md.
  '/vendor/xterm/xterm.js',
  '/vendor/xterm/xterm.css',
  '/tokens.css',
  '/client.js',
  '/pty.js',
  '/socket.js',
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
