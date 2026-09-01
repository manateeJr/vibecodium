import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CapabilityTokenClaims } from '../src/notify/types.js';
import type { Subsystem } from '../src/contracts/subsystem.js';
import { ControlPlane } from '../src/server/control-plane.js';

test('debug probe endpoint is bearer-protected and heartbeat includes probe data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-probe-endpoint-'));
  const dataPath = path.join(directory, 'control-plane.sqlite');
  const claims: CapabilityTokenClaims = {
    version: 1,
    token_id: 'probe-token',
    proposal_id: 'probe',
    action: 'probe',
    signature: 'probe',
    request_id: 'probe',
    scope: {},
    approval_event: 'action_approved',
    kid: 'probe',
    issued_at: Math.floor(Date.now() / 1_000) - 1,
    expires_at: Math.floor(Date.now() / 1_000) + 60,
    nonce: 'probe',
  };
  const tokenVerifier = {
    verify: (token: string) => (token === 'secret' ? claims : undefined),
    consume: (token: string) => (token === 'secret' ? claims : undefined),
  };
  const substrateProbe: Subsystem = {
    name: 'substrate-fixture',
    register(context) {
      context.registerProbe?.('substrate', () => ({
        status: 'healthy',
        metrics: { abduco: 1, registry: 1 },
      }));
    },
  };
  const controlPlane = new ControlPlane({
    dataPath,
    port: 0,
    subsystems: [substrateProbe],
    tokenVerifier,
  });
  try {
    const address = await controlPlane.start();
    const unauthorized = await fetch(`${address.httpUrl}/debug/probe`);
    assert.equal(unauthorized.status, 401);

    const allResponse = await fetch(`${address.httpUrl}/debug/probe`, {
      headers: { authorization: 'Bearer secret' },
    });
    assert.equal(allResponse.status, 200);
    const all = (await allResponse.json()) as {
      status: string;
      probes: Array<{ name: string; status: string }>;
    };
    assert.equal(all.probes.length, 4);
    assert.deepEqual(all.probes.map((probe) => probe.name).sort(), [
      'eventloop',
      'eventstore',
      'http',
      'substrate',
    ]);

    const oneResponse = await fetch(`${address.httpUrl}/debug/probe?target=eventloop`, {
      headers: { authorization: 'Bearer secret' },
    });
    const one = (await oneResponse.json()) as { probes: Array<{ name: string }> };
    assert.deepEqual(
      one.probes.map((probe) => probe.name),
      ['eventloop'],
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const heartbeat = JSON.parse(
      fs.readFileSync(path.join(directory, 'heartbeat.json'), 'utf8'),
    ) as { eventloop: unknown; probes: { probes: unknown[] } };
    assert.ok(heartbeat.eventloop);
    assert.equal(heartbeat.probes.probes.length, 4);
  } finally {
    await controlPlane.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
