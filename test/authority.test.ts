import assert from 'node:assert/strict';
import test from 'node:test';
import { Authority } from '../src/server/authority.js';

test('authority denies actions by default', () => {
  const authority = new Authority();
  assert.deepEqual(authority.evaluate({ type: 'filesystem.write', scope: { path: '/tmp/file' } }), {
    allowed: false,
    reason: 'unpermitted',
  });
});

test('authority allows an explicit scoped permission', () => {
  const authority = new Authority({
    permitted: [{ type: 'session.stop', scope: { session_id: 'session-1' } }],
  });
  assert.equal(
    authority.evaluate({ type: 'session.stop', scope: { session_id: 'session-1' } }).allowed,
    true,
  );
  assert.deepEqual(
    authority.evaluate({ type: 'session.stop', scope: { session_id: 'session-2' } }),
    { allowed: false, reason: 'unpermitted' },
  );
});

test('protected rules win before permitted rules', () => {
  const authority = new Authority({
    permitted: [{ type: 'filesystem.write', scope: { path: '*' } }],
    protected: [{ type: 'filesystem.write', scope: { path: '/etc/passwd' } }],
  });
  assert.deepEqual(
    authority.evaluate({ type: 'filesystem.write', scope: { path: '/etc/passwd' } }),
    { allowed: false, reason: 'protected' },
  );
  assert.equal(
    authority.evaluate({ type: 'filesystem.write', scope: { path: '/tmp/file' } }).allowed,
    true,
  );
});
