import type { SubstrateSessionInfo } from '../contracts/substrate-contract.js';

export function parseSessionListing(output: string): readonly SubstrateSessionInfo[] {
  const sessions: SubstrateSessionInfo[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.length === 0 || rawLine.startsWith('Active sessions')) continue;
    const fields = rawLine.split('\t');
    const name = fields.at(-1)?.trim();
    if (!name || fields.length < 4) continue;
    const pid = Number(fields.at(-2));
    sessions.push({
      name,
      live: rawLine[0] !== '+',
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    });
  }
  return sessions;
}
