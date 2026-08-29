import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlPlane } from '../src/server/control-plane.js';
import { createNotifySubsystem } from '../src/notify/index.js';

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-ntfy-turn-'));
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function setEnvironment(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test('ntfy sends turn_complete and verify_failed events when configured', async () => {
  const directory = temporaryDirectory();
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const restoreUrl = setEnvironment('VIBECODIUM_NTFY_URL', 'http://ntfy.test');
  const restoreTopic = setEnvironment('VIBECODIUM_NTFY_TOPIC', 'vibecodium-tests');
  try {
    const notify = createNotifySubsystem({
      filename: path.join(directory, 'notify.db'),
      ntfy: {
        fetch: async (input, init) => {
          requests.push({ url: String(input), init });
          return new Response(null, { status: 204 });
        },
      },
    });
    const controlPlane = new ControlPlane({
      dataPath: path.join(directory, 'events.sqlite'),
      subsystems: [notify],
    });
    try {
      controlPlane.context.append('stream-1', 'turn_complete', {
        session_id: 'session-1',
        turn: 2,
      });
      await nextTurn();
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.url, 'http://ntfy.test/vibecodium-tests');
      assert.equal(requests[0]?.init?.method, 'POST');
      assert.equal(
        (requests[0]?.init?.headers as Record<string, string> | undefined)?.Title,
        'omp turn done',
      );
      assert.equal(requests[0]?.init?.body, 'stream stream-1');

      controlPlane.context.append('stream-1', 'verify_failed', {
        stage: 'checks',
        error: 'tests failed',
      });
      await nextTurn();
      assert.equal(requests.length, 2);
      assert.equal(
        (requests[1]?.init?.headers as Record<string, string> | undefined)?.Title,
        'omp verify failed',
      );
      assert.equal(requests[1]?.init?.body, 'tests failed');
      assert.deepEqual(
        controlPlane.eventStore.readAll().map((event) => event.type),
        ['turn_complete', 'notify_emitted', 'verify_failed', 'notify_emitted'],
      );
    } finally {
      await controlPlane.stop();
      await notify.close();
    }
  } finally {
    restoreTopic();
    restoreUrl();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ntfy is a silent no-op when URL or topic is unset', async () => {
  const directory = temporaryDirectory();
  const requests: Request[] = [];
  const restoreUrl = setEnvironment('VIBECODIUM_NTFY_URL', undefined);
  const restoreTopic = setEnvironment('VIBECODIUM_NTFY_TOPIC', undefined);
  try {
    const notify = createNotifySubsystem({
      filename: path.join(directory, 'notify.db'),
      ntfy: {
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(null, { status: 204 });
        },
      },
    });
    const controlPlane = new ControlPlane({
      dataPath: path.join(directory, 'events.sqlite'),
      subsystems: [notify],
    });
    try {
      controlPlane.context.append('stream-1', 'turn_complete', {
        session_id: 'session-1',
        turn: 1,
      });
      await nextTurn();
      assert.equal(requests.length, 0);
      assert.deepEqual(
        controlPlane.eventStore.readAll().map((event) => event.type),
        ['turn_complete'],
      );
    } finally {
      await controlPlane.stop();
      await notify.close();
    }
  } finally {
    restoreTopic();
    restoreUrl();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
