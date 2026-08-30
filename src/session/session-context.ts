import type { SubsystemContext } from '../contracts/subsystem.js';
import type { SessionTable } from './session-table.js';

export function requireSessionTable(sessionTable: SessionTable | undefined): SessionTable {
  if (!sessionTable) throw new Error('session table is not configured');
  return sessionTable;
}

export function requireContext(context: SubsystemContext | undefined): SubsystemContext {
  if (!context) throw new Error('session subsystem is not registered');
  return context;
}
