export type CommandObject = Record<string, unknown>;

export function commandObject(command: unknown): CommandObject {
  if (typeof command === 'string') return { template: command };
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('workflow command must be an object');
  }
  return command as CommandObject;
}

export function stringField(input: CommandObject, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

export function booleanField(input: CommandObject, field: string): boolean | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

export function requiredWorkflowId(input: CommandObject): string {
  const workflowId = stringField(input, 'workflow_id') ?? stringField(input, 'id');
  if (!workflowId?.trim()) throw new Error('workflow_id is required');
  return workflowId;
}

export function isReleaseAction(action: string): boolean {
  return action === 'workflow.release' || action === 'release' || action === 'workflow:release';
}

export function workflowIdFromStream(streamId: string): string | undefined {
  return streamId.startsWith('workflow:') ? streamId.slice('workflow:'.length) : undefined;
}
