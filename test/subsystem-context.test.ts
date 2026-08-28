import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EventEnvelope } from '../src/contracts/events.js';
import type { Subsystem } from '../src/contracts/subsystem.js';
import { ControlPlane } from '../src/server/control-plane.js';

test('registers a global projector, replays its cursor, and receives new events', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-subsystem-'));
  const dataPath = path.join(directory, 'events.sqlite');
  const firstControlPlane = new ControlPlane({ dataPath });
  firstControlPlane.context.append('stream:a', 'session_started', {
    session_id: 'session-1',
    provider: 'fake',
    prompt: 'hello',
  });
  await firstControlPlane.stop();

  let registered = false;
  const projected: EventEnvelope[] = [];
  const subsystem: Subsystem = {
    name: 'dummy',
    register(ctx) {
      registered = true;
      ctx.registerProjector('dummy-projector', (event) => {
        projected.push(event);
      });
    },
  };
  const secondControlPlane = new ControlPlane({ dataPath, subsystems: [subsystem] });
  try {
    assert.equal(registered, true);
    assert.equal(projected[0]?.stream_id, 'stream:a');
    assert.equal(projected[0]?.seq, 1);

    const seq = secondControlPlane.context.append('stream:b', 'session_started', {
      session_id: 'session-2',
      provider: 'fake',
      prompt: 'world',
    });
    assert.equal(seq, 2);
    assert.deepEqual(
      projected.map((event) => [event.stream_id, event.seq]),
      [
        ['stream:a', 1],
        ['stream:b', 2],
      ],
    );
  } finally {
    await secondControlPlane.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
