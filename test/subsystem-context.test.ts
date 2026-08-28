import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope } from '../src/contracts/events.js';
import type { Subsystem } from '../src/contracts/subsystem.js';
import { ControlPlane } from '../src/server/control-plane.js';

test('registers a subsystem and projects events appended through its context', async () => {
  let registered = false;
  let projected: EventEnvelope | undefined;
  const subsystem: Subsystem = {
    name: 'dummy',
    register(ctx) {
      registered = true;
      ctx.registerProjector('dummy-projector', (event) => {
        projected = event;
      });
    },
  };
  const controlPlane = new ControlPlane({ dataPath: ':memory:', subsystems: [subsystem] });
  try {
    const seq = controlPlane.context.append('dummy', 'session_started', {
      session_id: 'session-1',
      provider: 'fake',
      prompt: 'hello',
    });

    assert.equal(registered, true);
    assert.equal(projected?.seq, seq);
    assert.equal(projected?.stream_id, 'dummy');
    assert.equal(projected?.type, 'session_started');
    assert.deepEqual(projected?.payload, {
      session_id: 'session-1',
      provider: 'fake',
      prompt: 'hello',
    });
  } finally {
    await controlPlane.stop();
  }
});
