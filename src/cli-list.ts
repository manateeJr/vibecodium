import { createInterface } from 'node:readline/promises';
import type { SessionSummary } from './contracts/commands.js';
import type { VibecodiumClient } from './client/index.js';

interface ListFilters {
  readonly project?: string;
  readonly query?: string;
  readonly includeAll: boolean;
  readonly json: boolean;
}

export async function runListCommand(client: VibecodiumClient, args: string[]): Promise<void> {
  const parsed = parseListFlags(args);
  if (!parsed) {
    printListUsage();
    return;
  }
  const filters =
    args.length === 0 && process.stdin.isTTY ? await promptListFilters(parsed) : parsed;
  const result = await client.listSessions({
    limit: 1_000,
    ...(filters.project === undefined ? {} : { project: filters.project }),
  });
  const sessions = result.sessions.filter((session) => matchesFilters(session, filters));
  if (filters.json) {
    process.stdout.write(`${JSON.stringify({ sessions })}\n`);
    return;
  }
  process.stdout.write(renderTable(sessions));
}

function parseListFlags(args: readonly string[]): ListFilters | undefined {
  let project: string | undefined;
  let query: string | undefined;
  let includeAll = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--all') {
      includeAll = true;
      continue;
    }
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--project' || flag === '--query') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      if (flag === '--project') project = value;
      else query = value;
      index += 1;
      continue;
    }
    return undefined;
  }
  return {
    ...(project === undefined ? {} : { project }),
    ...(query === undefined ? {} : { query }),
    includeAll,
    json,
  };
}

async function promptListFilters(filters: ListFilters): Promise<ListFilters> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const project = (await readline.question('project (optional): ')).trim();
    const query = (await readline.question('keywords (optional): ')).trim();
    return {
      ...filters,
      ...(project ? { project } : {}),
      ...(query ? { query } : {}),
    };
  } finally {
    readline.close();
  }
}

function matchesFilters(session: SessionSummary, filters: ListFilters): boolean {
  if (!filters.includeAll && session.origin !== 'operator') return false;
  if (filters.project !== undefined && session.project !== filters.project) return false;
  if (filters.query === undefined || !filters.query.trim()) return true;
  const haystack = [
    session.session_id,
    session.stream_id,
    session.label,
    session.origin,
    session.status,
    session.project,
    session.prompt,
    session.provider,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return filters.query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((keyword) => haystack.includes(keyword));
}

function renderTable(sessions: readonly SessionSummary[]): string {
  if (sessions.length === 0) return 'No sessions found.\n';
  const headers = ['LABEL', 'ORIGIN', 'STATE', 'PROJECT', 'UPDATED', 'ATTACH'];
  const rows = sessions.map((session) => [
    session.label || session.session_id,
    session.origin,
    session.status,
    session.project ?? '',
    session.updated_at ?? session.started_at ?? '',
    `vibecodium attach ${session.session_id}`,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const lines = [headers, ...rows].map((row) =>
    row
      .map((value, index) => value.padEnd(widths[index] ?? value.length))
      .join('  ')
      .trimEnd(),
  );
  return `${lines.join('\n')}\n`;
}

function printListUsage(): void {
  process.stderr.write('usage: vibecodium list [--project <p>] [--query <q>] [--all] [--json]\n');
  process.exitCode = 2;
}
