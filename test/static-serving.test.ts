import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlPlane } from '../src/server/control-plane.js';

function temporaryPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-static-')), 'events.sqlite');
}

test('control plane serves the pocket foundation assets without changing API routes', async () => {
  const dataPath = temporaryPath();
  const plane = new ControlPlane({ dataPath, port: 0 });
  try {
    const address = await plane.start();

    const indexResponse = await fetch(`${address.httpUrl}/`);
    assert.equal(indexResponse.status, 200);
    assert.equal(indexResponse.headers.get('content-type'), 'text/html');
    assert.match(await indexResponse.text(), /Vibecodium/);

    const tokensResponse = await fetch(`${address.httpUrl}/tokens.css`);
    assert.equal(tokensResponse.status, 200);
    assert.equal(tokensResponse.headers.get('content-type'), 'text/css');
    assert.match(await tokensResponse.text(), /--ink:#86ffc0/);

    const clientResponse = await fetch(`${address.httpUrl}/client.js`);
    assert.equal(clientResponse.status, 200);
    assert.equal(clientResponse.headers.get('content-type'), 'text/javascript');
    assert.match(await clientResponse.text(), /createClient/);

    // The vendored xterm.js bundle must be served whole and executable: a truncated bundle would
    // leave the phone's live mirror permanently blank.
    const bundlePath = new URL('../../web/vendor/xterm/xterm.js', import.meta.url);
    const bundleOnDisk = fs.readFileSync(bundlePath, 'utf8');
    const bundleResponse = await fetch(`${address.httpUrl}/vendor/xterm/xterm.js`);
    assert.equal(bundleResponse.status, 200);
    assert.equal(bundleResponse.headers.get('content-type'), 'text/javascript');
    const bundle = await bundleResponse.text();
    assert.equal(bundle.length, bundleOnDisk.length);
    assert.match(bundle, /e\.Terminal=/, 'the UMD bundle must still export Terminal');

    const xtermCssResponse = await fetch(`${address.httpUrl}/vendor/xterm/xterm.css`);
    assert.equal(xtermCssResponse.status, 200);
    assert.equal(xtermCssResponse.headers.get('content-type'), 'text/css');
    assert.match(await xtermCssResponse.text(), /\.xterm-viewport/);

    const surfaceResponse = await fetch(`${address.httpUrl}/surface.css`);
    assert.equal(surfaceResponse.status, 200);
    assert.equal(surfaceResponse.headers.get('content-type'), 'text/css');
    assert.match(await surfaceResponse.text(), /\.pty-mirror__viewport/);

    const traversalResponse = await fetch(`${address.httpUrl}/..%2fpackage.json`);
    assert.notEqual(traversalResponse.status, 200);
    assert.doesNotMatch(await traversalResponse.text(), /"name"\s*:\s*"vibecodium"/);

    const healthResponse = await fetch(`${address.httpUrl}/healthz`);
    assert.equal(healthResponse.status, 200);
    const health = (await healthResponse.json()) as { ok?: boolean };
    assert.equal(health.ok, true);
  } finally {
    await plane.stop();
    fs.rmSync(path.dirname(dataPath), { recursive: true, force: true });
  }
});
