import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function ensureSubstrateBinary(repositoryRoot) {
  const binary = path.join(repositoryRoot, '.vibecodium', 'bin', 'abduco');
  if (fs.existsSync(binary)) return { available: true, output: '' };
  const result = spawnSync(process.execPath, ['scripts/setup-substrate.mjs'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
  return { available: result.status === 0 && fs.existsSync(binary), output };
}

export function installFakeOmpHarness(root) {
  const bin = path.join(root, 'fake-bin');
  const executable = path.join(bin, 'omp');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const marker = args.indexOf('--session-dir');
const sessionDir = marker >= 0 ? args[marker + 1] : undefined;
if (typeof sessionDir !== 'string' || !sessionDir) process.exit(2);
fs.mkdirSync(sessionDir, { recursive: true });
const transcript = path.join(sessionDir, 'session.jsonl');
const record = (role, text) => fs.appendFileSync(transcript, JSON.stringify({
  message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { stopReason: 'stop' } : {}) },
}) + '\\n');
const respond = (text) => {
  const clean = text.replace(/\\s+/g, ' ').trim();
  if (!clean) return;
  record('user', clean);
  setTimeout(() => record('assistant', 'fake:' + clean), 150);
};
const prompt = args[args.length - 1];
if (typeof prompt === 'string' && prompt !== '--') respond(prompt);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString().replace(/\\x1b\\[[0-9;]*[A-Za-z~]/g, '');
  if (buffer.includes('\\x15')) buffer = buffer.slice(buffer.lastIndexOf('\\x15') + 1);
  const parts = buffer.split(/[\\r\\n]/);
  buffer = parts.pop() ?? '';
  for (const part of parts) respond(part);
});
process.stdin.resume();
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  return bin;
}
