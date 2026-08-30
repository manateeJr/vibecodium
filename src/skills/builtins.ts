import type { SkillDef, SkillParam } from '../contracts/commands.js';

function enumParam(name: string, options: readonly string[]): SkillParam {
  return {
    name,
    type: 'enum',
    required: true,
    options,
    source: 'prompt',
  };
}

export const BUILTIN_SKILLS: readonly SkillDef[] = [
  {
    id: 'grill-me',
    name: 'Grill Me',
    description: 'Stress-test a proposal until its assumptions and decision points are explicit.',
    body: [
      'Act as a relentless but constructive decision reviewer for the proposal in context.',
      'Probe assumptions, missing evidence, edge cases, trade-offs, and irreversible choices.',
      'Ask one sharply targeted question at a time when an answer is needed; do not rubber-stamp',
      'the proposal and do not invent facts. Once the reasoning is sound, summarize the decision,',
      'remaining risks, and the smallest next action.',
    ].join(' '),
    params: [],
    builtin: true,
  },
  {
    id: 'wayfinder',
    name: 'Wayfinder',
    description:
      'Turn a multi-issue product or architecture problem into a grounded decision ledger.',
    body: [
      'Act as the Wayfinder architect for this repository. Ground every recommendation in the',
      'actual code, tracker, and runtime constraints. Group related work into coherent themes,',
      'separate facts from decisions, record dependencies and superseded approaches, and keep a',
      'durable decision ledger. Close work that is already live, then produce an implementation',
      'sequence with explicit acceptance evidence for every remaining item.',
    ].join(' '),
    params: [],
    builtin: true,
  },
  {
    id: 'file-gh-issue',
    name: 'File GitHub Issue',
    description: 'Ground and file a GitHub issue or a coherent batch of issues.',
    body: [
      'Use the repository GitHub workflow to turn the current request into a code-grounded issue.',
      'Operating mode: {mode}. Inspect the relevant files and existing tracker before writing.',
      'In single mode, file one narrowly scoped issue with reproduction, impact, acceptance criteria,',
      'and exact file touchpoints. In batch mode, group only genuinely related issues, identify',
      'dependencies and collision-free ownership, and give each issue an independently verifiable',
      'acceptance criterion. Do not file speculative work or duplicate an existing ticket.',
    ].join(' '),
    params: [enumParam('mode', ['single', 'batch'])],
    builtin: true,
  },
  {
    id: 'batch-handle-gh-issues',
    name: 'Batch Handle GitHub Issues',
    description: 'Triage and execute a coherent, collision-free batch of tracker issues.',
    body: [
      'Handle a coherent batch of GitHub issues from the repository tracker. Re-ground each issue',
      'against the current branch, exclude epics and owner-gated work that is not independently',
      'runnable, map real file ownership, and fan out only disjoint implementation lanes. Require',
      'each lane to ship its observable behavior and focused tests, then integrate the combined',
      'tree once, attribute failures to the correct lane, and report the evidence and any blocked',
      'items without silently narrowing scope.',
    ].join(' '),
    params: [],
    builtin: true,
  },
  {
    id: 'advisor',
    name: 'Advisor',
    description:
      'Challenge, sequence, delegate, and verify repository work as an opinionated advisor.',
    body: [
      'Act as an opinionated advisor for this repository. Cost mode: {mode}. Clarify the real goal,',
      'challenge weak assumptions, identify dependencies and file collisions, and propose the',
      'smallest complete implementation plan. Delegate genuinely independent lanes with explicit',
      'contracts, inspect their claims against the worktree, run the authoritative acceptance gate,',
      'and report what is proven, what is blocked, and what decision the owner must make next.',
    ].join(' '),
    params: [enumParam('mode', ['budget', 'full'])],
    builtin: true,
  },
];
