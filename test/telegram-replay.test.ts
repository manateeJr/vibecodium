import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const substrateBinary = path.join(repositoryRoot, '.vibecodium', 'bin', 'abduco');

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

test('Telegram replay smoke drives both surfaces with the fake provider', async (t) => {
  if (!existsSync(substrateBinary)) {
    t.skip(`replay smoke skipped: ${substrateBinary} is absent; run npm run setup:substrate`);
    return;
  }

  const result = await runReplayProcess();
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  for (const step of [1, 2, 3, 4, 5]) {
    assert.match(result.stdout, new RegExp(`\\| ${step} \\| telegram \\|`));
    assert.match(result.stdout, new RegExp(`\\| ${step} \\| terminal \\|`));
  }
  assert.match(result.stdout, /\| 2 \| terminal \| 2 \| yes \| yes \| OK \|/);
  assert.match(result.stdout, /session_state state=resumable reason=reaped/);
});

test('Telegram replay proves a plain control-plane session can bind and reply', async (t) => {
  if (!existsSync(substrateBinary)) {
    t.skip(`replay bind skipped: ${substrateBinary} is absent; run npm run setup:substrate`);
    return;
  }

  const result = await runReplayProcess('bind.json');
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /\[bind\].*reply="bound to session [^"]+"/);
  assert.match(result.stdout, /\[bind\].*assistant="fake:reply from the bound topic"/);
  assert.match(result.stdout, /\| 2 \| telegram \| \d+ \| yes \| yes \| OK \|/);
});

function runReplayProcess(replayName = 'smoke.json'): Promise<ChildResult> {
  const script = path.join(repositoryRoot, 'scripts/telegram-replay.mjs');
  const replay = path.join(repositoryRoot, 'scripts/replays', replayName);
  const child = spawn(process.execPath, [script, replay, '--provider', 'fake'], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise<ChildResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000);
      settled = true;
      reject(new Error(`Telegram replay timed out\n${stdout}\n${stderr}`));
    }, 180_000);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
