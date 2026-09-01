import assert from 'node:assert/strict';
import test from 'node:test';
import { planeSocketDir, socketPathCandidates } from '../src/substrate/paths.js';

const environment = {
  XDG_RUNTIME_DIR: '/tmp/vibecodium-runtime',
  HOME: '/tmp/vibecodium-home',
  TMPDIR: '/tmp/vibecodium-tmp',
};
const worstCaseSessionName = `substrate-${'0'.repeat(36)}`;

test('plane socket directories are deterministic and data-path scoped', () => {
  const first = planeSocketDir('/var/lib/vibecodium/first.sqlite', environment);
  const repeat = planeSocketDir('/var/lib/vibecodium/first.sqlite', environment);
  const second = planeSocketDir('/var/lib/vibecodium/second.sqlite', environment);

  if (first === undefined || second === undefined)
    throw new Error('expected a plane socket directory');
  assert.equal(first, repeat);
  assert.notEqual(first, second);

  const socketPath = socketPathCandidates(worstCaseSessionName, {
    socketDir: first,
    environment,
  })[0];
  if (socketPath === undefined) throw new Error('expected a configured socket path');
  assert.ok(Buffer.byteLength(socketPath) < 108, socketPath);
});

test('plane socket directory leaves explicit and in-memory namespaces untouched', () => {
  assert.equal(
    planeSocketDir('/var/lib/vibecodium/control-plane.sqlite', {
      ...environment,
      ABDUCO_SOCKET_DIR: '/operator/abduco',
    }),
    undefined,
  );
  assert.equal(planeSocketDir(':memory:', environment), undefined);
  assert.equal(planeSocketDir('', environment), undefined);
});
