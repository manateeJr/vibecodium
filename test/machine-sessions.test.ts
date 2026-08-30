import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
import { createMachineSessionsSubsystem } from '../src/machine-sessions/index.js';

function writeSession(file: string, lines: readonly unknown[], mtime: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

test('machine.list reads OMP and nested Codex session stores newest-first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-machine-sessions-'));
  const ompRoot = path.join(root, 'omp', 'sessions');
  const codexRoot = path.join(root, 'codex', 'sessions');
  const ompRef = '01a04c8a-9a8a-7000-bd8e-6ee0c36ece1f';
  const codexRef = '019fe016-08d8-7651-9c21-653b5e1c1143';
  const ompFile = path.join(ompRoot, '-tmp', `2026-08-29T08-00-00-000Z_${ompRef}`, 'session.jsonl');
  const codexFile = path.join(
    codexRoot,
    '2026',
    '08',
    '29',
    `rollout-2026-08-29T08-01-00-${codexRef}.jsonl`,
  );
  try {
    writeSession(
      ompFile,
      [
        { type: 'title', title: 'OMP title' },
        { type: 'session_init', agent: 'task' },
        { type: 'session', cwd: '/workspace/omp' },
      ],
      2_000,
    );
    writeSession(
      codexFile,
      [
        { type: 'session_meta', payload: { cwd: '/workspace/codex' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Codex title' }],
          },
        },
      ],
      3_000,
    );

    const commands = new Map<string, CommandHandler>();
    createMachineSessionsSubsystem({ ompRoot, codexRoot, now: () => new Date(0) }).register({
      registerCommand(name: string, handler: CommandHandler) {
        commands.set(name, handler);
      },
    } as unknown as SubsystemContext);

    const result = await commands.get(COMMAND_NAMES.machineList)?.({});
    assert.deepEqual(result, {
      sessions: [
        {
          source: 'codex',
          ref: codexRef,
          title: 'Codex title',
          cwd: '/workspace/codex',
          updated_at: new Date(3_000).toISOString(),
          kind: 'main',
        },
        {
          source: 'omp',
          ref: ompRef,
          title: 'OMP title',
          cwd: '/workspace/omp',
          updated_at: new Date(2_000).toISOString(),
          kind: 'subagent',
        },
      ],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('machine.list skips missing and malformed stores', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-machine-sessions-'));
  const ompRoot = path.join(root, 'omp');
  fs.mkdirSync(ompRoot, { recursive: true });
  fs.writeFileSync(path.join(ompRoot, 'bad.jsonl'), '{not-json}\n');
  const commands = new Map<string, CommandHandler>();
  try {
    createMachineSessionsSubsystem({ ompRoot, codexRoot: path.join(root, 'missing') }).register({
      registerCommand(name: string, handler: CommandHandler) {
        commands.set(name, handler);
      },
    } as unknown as SubsystemContext);
    assert.deepEqual(await commands.get(COMMAND_NAMES.machineList)?.({}), { sessions: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
