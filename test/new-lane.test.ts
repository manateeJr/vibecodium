import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repositoryRoot, 'scripts', 'new-lane');

function run(args: readonly string[]) {
  return spawnSync(script, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, VIBECODIUM_SKIP_GH: '1' },
  });
}

test('new-lane rejects an unsupported explicit type with usage', () => {
  const result = run(['release', '42']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /type must be one of build, fix, feat, chore, or docs/);
  assert.match(result.stderr, /usage: scripts\/new-lane \[type\] <N> \[slug\]/);
});

test('new-lane requires a positive integer issue number', () => {
  for (const args of [
    ['feat', '0'],
    ['0', 'default-slug'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /issue number must be a positive integer/);
  }
});

test('new-lane rejects a slug that sanitizes to empty', () => {
  const result = run(['42', '***']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /slug is empty after sanitization/);
  assert.match(result.stderr, /type defaults to feat/);
});
