import { open } from 'node:fs/promises';
import type {
  MachineReadArgs,
  MachineReadResult,
  MachineReadTurn,
} from '../contracts/machine-commands.js';
import { ompHarnessPlugin } from '../provider/omp-harness-plugin.js';

const SESSION_TAIL_BYTES = 256 * 1024;

export async function readMachineTranscript(
  path: string,
  limit: number,
): Promise<readonly MachineReadTurn[]> {
  if (limit === 0) return [];
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const offset = Math.max(0, size - SESSION_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.toString('utf8', 0, bytesRead);
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline < 0) return [];
      text = text.slice(firstNewline + 1);
    }
    const turns: MachineReadTurn[] = [];
    for (const line of text.split(/\r?\n/)) {
      const record = ompHarnessPlugin.parseTranscriptLine(line);
      if (!record?.text?.trim()) continue;
      if (record.kind !== 'user' && record.kind !== 'steering' && record.kind !== 'assistant')
        continue;
      turns.push({
        role: record.kind === 'assistant' ? 'assistant' : 'user',
        text: record.text,
        ...(record.ts === undefined ? {} : { ts: record.ts }),
      });
    }
    return turns.slice(-limit);
  } finally {
    await handle.close();
  }
}

export function machineReadArgs(command: unknown): MachineReadArgs {
  const value = asRecord(command);
  if (!value) throw new Error('machine.read arguments must be an object');
  if (value.source !== 'omp' && value.source !== 'codex') {
    throw new Error('source must be omp or codex');
  }
  if (typeof value.ref !== 'string' || !value.ref.trim()) throw new Error('ref is required');
  let limit: number | undefined;
  if (value.limit !== undefined) {
    if (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 0) {
      throw new Error('limit must be a non-negative integer');
    }
    limit = value.limit;
  }
  return {
    source: value.source,
    ref: value.ref,
    ...(limit === undefined ? {} : { limit }),
  };
}

export const DEFAULT_MACHINE_READ_LIMIT = 50;

export function machineReadResult(
  turns: readonly MachineReadTurn[],
  note?: string,
): MachineReadResult {
  return note === undefined ? { turns } : { turns, note };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
