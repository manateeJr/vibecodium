import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import type { Project, SessionSummary } from './contracts/commands.js';
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
    args.length === 0 && process.stdin.isTTY ? await promptListFilters(client, parsed) : parsed;
  if (filters === undefined) return;
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

export function filterProjectChoices<T extends Pick<Project, 'name'>>(
  projects: readonly T[],
  input: string,
): readonly T[] {
  const query = input.trim().toLowerCase();
  if (!query) return projects;
  return projects.filter((project) => project.name.toLowerCase().includes(query));
}

async function promptListFilters(
  client: VibecodiumClient,
  filters: ListFilters,
): Promise<ListFilters | undefined> {
  const projectResult = await client.listProjects();
  const project = await promptProjectPicker(projectResult.projects);
  if (project === null) return undefined;

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const query = (await readline.question('keywords (optional): ')).trim();
    return {
      ...filters,
      ...(project === undefined ? {} : { project }),
      ...(query ? { query } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return undefined;
    throw error;
  } finally {
    readline.close();
  }
}

type ProjectPickerResult = string | null | undefined;

function promptProjectPicker(projects: readonly Project[]): Promise<ProjectPickerResult> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();

  let input = '';
  let renderedLines = 0;
  let settled = false;
  return new Promise<ProjectPickerResult>((resolve) => {
    const render = () => {
      const choices = filterProjectChoices(projects, input);
      const lines = [
        `Select project (type to filter, number to select, Enter for all): ${input}`,
        ...choices.map((project, index) => `${index + 1}. ${project.name} (${project.path})`),
      ];
      if (choices.length === 0) lines.push('No matching projects.');
      if (renderedLines > 0) stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
      stdout.write(`${lines.join('\n')}\n`);
      renderedLines = lines.length;
    };

    const finish = (result: ProjectPickerResult) => {
      if (settled) return;
      settled = true;
      stdin.off('keypress', onKeypress);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      if (renderedLines > 0) stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
      stdout.write(
        result === null ? '\n' : result === undefined ? 'project: all\n' : `project: ${result}\n`,
      );
      resolve(result);
    };

    const onKeypress = (
      sequence: string,
      key: { readonly name?: string; readonly ctrl?: boolean },
    ) => {
      if (key.ctrl && key.name === 'c') {
        finish(null);
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const choices = filterProjectChoices(projects, input);
        if (!input.trim()) {
          finish(undefined);
        } else if (choices.length === 1) {
          finish(choices[0]?.name);
        }
        return;
      }
      if (key.name === 'backspace') {
        input = input.slice(0, -1);
        render();
        return;
      }
      if (/^[1-9]$/.test(sequence)) {
        const choice = filterProjectChoices(projects, input)[Number(sequence) - 1];
        if (choice) finish(choice.name);
        return;
      }
      if (!key.ctrl && sequence >= ' ') {
        input += sequence;
        render();
      }
    };

    stdin.on('keypress', onKeypress);
    render();
  });
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
