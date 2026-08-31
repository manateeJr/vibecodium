import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlPlane } from '../src/server/control-plane.js';

type ManifestIcon = {
  readonly purpose?: string;
};

type Manifest = {
  readonly display?: string;
  readonly start_url?: string;
  readonly icons?: readonly ManifestIcon[];
};

function temporaryPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-pwa-')), 'events.sqlite');
}

test('serves the installable pocket PWA shell and static assets', async () => {
  const dataPath = temporaryPath();
  const plane = new ControlPlane({ dataPath, port: 0 });
  try {
    const address = await plane.start();

    const indexResponse = await fetch(`${address.httpUrl}/`);
    assert.equal(indexResponse.status, 200);
    assert.equal(indexResponse.headers.get('content-type'), 'text/html');
    const index = await indexResponse.text();
    assert.match(index, /href="\/manifest\.webmanifest"/);
    assert.match(index, /script type="module" src="\/app\.js"/);
    assert.match(index, /serviceWorker\.register\('\/sw\.js'/);
    // The main column is header → transcript → composer: the session bar, the AGENTS pill, the
    // view-tabs strip and the project-scope block above the composer are all gone.
    assert.doesNotMatch(index, /id="session-bar"/);
    assert.doesNotMatch(index, /id="structured-view-tab"/);
    assert.doesNotMatch(index, /id="mirror-view-tab"/);
    assert.doesNotMatch(index, /class="project-scope/);
    assert.doesNotMatch(index, /id="compose-hint"/);
    assert.doesNotMatch(index, /id="stream-caption"/);
    assert.match(index, /id="session-chip"/);
    assert.match(index, /id="session-menu"/);
    assert.match(index, /id="active-project"/);
    assert.match(index, /id="home-view"/);
    assert.match(index, /id="home-recent"/);
    assert.match(index, /id="external-hint"/);
    // The scope pickers and the project's quick starts moved into HISTORY's `+ NEW` flow.
    assert.match(index, /id="new-session"/);
    assert.match(index, /id="new-session-flow"/);
    assert.match(index, /id="session-presets"/);
    // The AGENTS toggle is a Settings preference now, not a control above the composer.
    assert.match(index, /id="show-agents"/);
    assert.match(index, /id="compose-form"/);
    assert.match(index, /id="compose-input"/);
    assert.match(index, /id="compose-send"/);
    assert.match(index, /id="compose-note"/);
    assert.match(index, /id="voice-record"/);
    assert.match(index, /id="scope-path"/);
    assert.match(index, /placeholder="New session in Scratch…"/);
    assert.match(index, />SEND</);
    assert.doesNotMatch(index, />OPEN</);
    // The unified composer replaced the duplicate open/send inputs and the compose noise.
    assert.doesNotMatch(index, /id="turnForm"/);
    assert.doesNotMatch(index, /id="turnInput"/);
    assert.doesNotMatch(index, /id="prompt-form"/);
    assert.doesNotMatch(index, /id="workspace"/);
    assert.doesNotMatch(index, /id="project-filter"/);
    assert.doesNotMatch(index, /id="recent-projects"/);
    assert.doesNotMatch(index, /id="quick-actions"/);
    assert.doesNotMatch(index, /id="quick-actions-refresh"/);
    assert.doesNotMatch(index, /id="stop-session"/);
    assert.doesNotMatch(index, /FREE SESSION/);
    assert.doesNotMatch(index, /id="provider"/);
    assert.doesNotMatch(index, /id="mode-chat"/);
    assert.doesNotMatch(index, /id="mode-workflow"/);
    assert.doesNotMatch(index, /workflow/i);
    assert.match(index, /id="history-toggle"/);
    assert.match(index, /id="settings-toggle"/);
    assert.match(index, /id="project-selector"/);
    assert.match(index, /id="add-project"/);
    assert.match(index, /id="add-project-form"/);
    assert.match(index, /id="managed-projects"/);
    assert.match(index, /MANAGE PROJECTS/);
    assert.doesNotMatch(index, /id="remove-project"/);
    assert.match(index, /id="project-proposals"/);
    assert.match(index, /id="host-panel"/);
    assert.match(index, /id="host-stats"/);
    assert.match(index, /id="host-cap"/);
    assert.match(index, /id="host-cap-apply"/);
    assert.match(index, /id="host-refresh"/);
    assert.match(index, /id="history-drawer"/);
    assert.match(index, /id="history-search"/);
    assert.match(index, /id="history-project-filter"/);
    assert.match(index, /id="settings-drawer"/);
    assert.match(index, /id="history-scroll"/);
    assert.match(index, /JUMP TO LATEST/);
    // The read-only live mirror, reached from the chip menu, and its steering/interrupt controls.
    assert.match(index, /id="mirror-status"/);
    assert.match(index, /id="pty-terminal"/);
    assert.match(index, /id="pty-mirror-empty"/);
    assert.match(index, /id="interrupt-key"/);
    assert.match(index, /href="\/surface\.css"/);
    // xterm.js is a vendored static asset loaded as a classic script, never an npm dependency.
    assert.match(index, /script src="\/vendor\/xterm\/xterm\.js"/);
    assert.match(index, /href="\/vendor\/xterm\/xterm\.css"/);
    const manifestResponse = await fetch(`${address.httpUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    assert.equal(manifestResponse.headers.get('content-type'), 'application/manifest+json');
    const manifest = (await manifestResponse.json()) as Manifest;
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert.ok(manifest.icons?.some((icon) => icon.purpose === 'maskable'));

    const serviceWorkerResponse = await fetch(`${address.httpUrl}/sw.js`);
    assert.equal(serviceWorkerResponse.status, 200);
    assert.equal(serviceWorkerResponse.headers.get('content-type'), 'text/javascript');

    const appResponse = await fetch(`${address.httpUrl}/app.js`);
    assert.equal(appResponse.status, 200);
    assert.equal(appResponse.headers.get('content-type'), 'text/javascript');
    // /client.js must stay a SINGLE standalone browser module. If it ever grows a relative import,
    // the browser's module graph 404s and the whole PWA dies, because the control plane serves the
    // SDK from one hand-written route and nothing else from dist/.
    const clientBundle = await (await fetch(`${address.httpUrl}/client.js`)).text();
    assert.doesNotMatch(clientBundle, /^\s*import\s/m, 'the client bundle must have no imports');
    for (const orphan of ['/pty.js', '/socket.js']) {
      const response = await fetch(`${address.httpUrl}${orphan}`);
      assert.equal(response.status, 404, orphan);
    }

    const pocketCssResponse = await fetch(`${address.httpUrl}/pocket.css`);
    assert.equal(pocketCssResponse.status, 200);
    assert.equal(pocketCssResponse.headers.get('content-type'), 'text/css');

    const uiResponse = await fetch(`${address.httpUrl}/ui.css`);
    assert.equal(uiResponse.status, 200);
    assert.equal(uiResponse.headers.get('content-type'), 'text/css');
    const layoutResponse = await fetch(`${address.httpUrl}/layout.css`);
    assert.equal(layoutResponse.status, 200);
    assert.equal(layoutResponse.headers.get('content-type'), 'text/css');
    const eventsResponse = await fetch(`${address.httpUrl}/ui/events.js`);
    assert.equal(eventsResponse.status, 200);
    const projectManagerResponse = await fetch(`${address.httpUrl}/ui/project-manager.js`);
    assert.equal(projectManagerResponse.status, 200);
    assert.equal(projectManagerResponse.headers.get('content-type'), 'text/javascript');
    assert.equal(eventsResponse.headers.get('content-type'), 'text/javascript');
    const markdownResponse = await fetch(`${address.httpUrl}/lib/markdown.js`);
    assert.equal(markdownResponse.status, 200);
    assert.match(await markdownResponse.text(), /copy-button/);
    for (const module of [
      '/ui/voice.js',
      '/ui/host-panel.js',
      '/ui/elements.js',
      '/lib/session-items.js',
      '/lib/session-state.js',
      '/ui/pty-mirror.js',
      '/ui/session-surface.js',
      '/ui/session-view.js',
      '/ui/session-chip.js',
      '/ui/home-view.js',
      '/ui/history-row.js',
      '/ui/external-hint.js',
    ]) {
      const moduleResponse = await fetch(`${address.httpUrl}${module}`);
      assert.equal(moduleResponse.status, 200, module);
      assert.equal(moduleResponse.headers.get('content-type'), 'text/javascript');
    }
    // Clean cutover: the deleted session bar must not still be served to a cached shell.
    for (const orphan of ['/ui/project-picker.js', '/ui/session-bar.js']) {
      assert.equal((await fetch(`${address.httpUrl}${orphan}`)).status, 404, orphan);
    }
  } finally {
    await plane.stop();
    fs.rmSync(path.dirname(dataPath), { recursive: true, force: true });
  }
});
