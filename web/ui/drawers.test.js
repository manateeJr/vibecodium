import assert from 'node:assert/strict';
import test from 'node:test';
import { groupRecentItems } from './drawers.js';

test('archived sessions leave active history groups', () => {
  const pinned = { session_id: 'pinned', state: 'done', pinned: true };
  const live = { session_id: 'live', state: 'running' };
  const resumable = { session_id: 'resumable', state: 'resumable' };
  const ended = { session_id: 'ended', state: 'done' };
  const archived = { session_id: 'archived', state: 'done', pinned: true, archived: true };
  const groups = groupRecentItems([pinned, live, resumable, ended, archived]);

  assert.deepEqual(groups.pinned, [pinned]);
  assert.deepEqual(groups.live, [live]);
  assert.deepEqual(groups.resumable, [resumable]);
  assert.deepEqual(groups.ended, [ended]);
  assert.deepEqual(groups.archived, [archived]);
});
