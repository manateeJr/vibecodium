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
    assert.match(index, /id="session-bar"/);
    assert.match(index, /id="session-presets"/);
    assert.match(index, /id="compose-form"/);
    assert.match(index, /id="compose-input"/);
    assert.match(index, /id="compose-send"/);
    assert.match(index, /id="compose-note"/);
    assert.match(index, /id="voice-record"/);
    assert.match(index, /id="scope-path"/);
    assert.match(index, /placeholder="Describe a task to start a session…"/);
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
    assert.doesNotMatch(index, /class="project-scope__button/);
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
      '/ui/session-bar.js',
      '/ui/voice.js',
      '/ui/host-panel.js',
      '/ui/elements.js',
      '/lib/session-items.js',
    ]) {
      const moduleResponse = await fetch(`${address.httpUrl}${module}`);
      assert.equal(moduleResponse.status, 200, module);
      assert.equal(moduleResponse.headers.get('content-type'), 'text/javascript');
    }
    const pickerResponse = await fetch(`${address.httpUrl}/ui/project-picker.js`);
    assert.equal(pickerResponse.status, 404);
  } finally {
    await plane.stop();
    fs.rmSync(path.dirname(dataPath), { recursive: true, force: true });
  }
});
