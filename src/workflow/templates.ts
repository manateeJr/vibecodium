import type { WorkflowStage } from './types.js';

export const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'spec',
  'build',
  'verify',
  'review',
  'approve',
  'release',
];

export interface WorkflowStageDefinition {
  readonly stage: WorkflowStage;
  readonly description: string;
  readonly command?: readonly string[];
}

export interface WorkflowTemplate {
  readonly name: string;
  readonly image: string;
  readonly stages: readonly WorkflowStageDefinition[];
}

export const BASIC_BUILD_TEMPLATE: WorkflowTemplate = {
  name: 'basic-build',
  image: 'docker.io/library/node:22-alpine',
  stages: [
    {
      stage: 'spec',
      description: 'Capture the requested change as an executable specification.',
    },
    {
      stage: 'build',
      description: 'Build the requested change in the isolated lane.',
    },
    {
      stage: 'verify',
      description: 'Run the lane verification command in a rootless sandbox.',
      command: ['node', '-e', 'process.stdout.write("basic-build verified")'],
    },
    {
      stage: 'review',
      description: 'Prepare the verified result for human review.',
    },
    {
      stage: 'approve',
      description: 'Wait for an explicit release approval.',
    },
    {
      stage: 'release',
      description: 'Publish the approved result to the mainline.',
    },
  ],
};

export const FIRST_WORKFLOW_TEMPLATE = BASIC_BUILD_TEMPLATE;

export function templateStage(
  template: WorkflowTemplate,
  stage: WorkflowStage,
): WorkflowStageDefinition {
  const definition = template.stages.find((candidate) => candidate.stage === stage);
  if (!definition) throw new Error(`template ${template.name} is missing stage ${stage}`);
  return definition;
}
