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
    assert.match(index, /id="workspace"/);
    assert.match(index, /id="turnForm"/);
    assert.match(index, /id="turnInput"/);

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
  } finally {
    await plane.stop();
    fs.rmSync(path.dirname(dataPath), { recursive: true, force: true });
  }
});
