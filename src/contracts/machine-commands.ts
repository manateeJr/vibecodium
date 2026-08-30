export const MACHINE_READ_COMMAND = 'machine.read' as const;

export interface MachineSessionSummary {
  readonly source: 'omp' | 'codex';
  readonly ref: string;
  readonly title: string;
  readonly cwd: string;
  readonly kind: 'main' | 'subagent';
  readonly updated_at: string;
}

export type MachineListArgs = Record<string, never>;

export interface MachineListResult {
  readonly sessions: readonly MachineSessionSummary[];
}

export interface MachineReadArgs {
  readonly source: 'omp' | 'codex';
  readonly ref: string;
  readonly limit?: number;
}

export interface MachineReadTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly ts?: string;
}

export interface MachineReadResult {
  readonly turns: readonly MachineReadTurn[];
  readonly note?: string;
}
