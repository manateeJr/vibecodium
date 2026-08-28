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
