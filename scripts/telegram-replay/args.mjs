import fs from 'node:fs';
import path from 'node:path';

export function parseReplayArgs(argv) {
  const scriptArgument = argv.find((argument) => !argument.startsWith('--'));
  if (scriptArgument === undefined) {
    throw new Error(
      'usage: node scripts/telegram-replay.mjs <script.json> [--keep] [--strict-echo] [--no-strict-echo] [--provider omp|fake]',
    );
  }
  let provider = 'omp';
  let keep = false;
  let strictEcho = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === scriptArgument) continue;
    if (argument === '--keep') {
      keep = true;
      continue;
    }
    if (argument === '--strict-echo') {
      continue;
    }
    if (argument === '--no-strict-echo') {
      strictEcho = false;
      continue;
    }
    if (argument === '--provider') {
      provider = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument?.startsWith('--provider=')) {
      provider = argument.slice('--provider='.length);
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (provider !== 'omp' && provider !== 'fake') {
    throw new Error(`provider must be omp or fake, got ${provider ?? '(missing)'}`);
  }
  const scriptPath = path.resolve(process.cwd(), scriptArgument);
  let script;
  try {
    script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `could not read replay script ${scriptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateScript(script, scriptPath);
  return { scriptPath, script, provider, keep, strictEcho };
}

function validateScript(script, scriptPath) {
  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    throw new Error(`${scriptPath}: root must be an object`);
  }
  const project = script.project;
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error(`${scriptPath}: project must be an object`);
  }
  if (typeof project.name !== 'string' || project.name.trim() === '') {
    throw new Error(`${scriptPath}: project.name must be a non-empty string`);
  }
  if (project.path !== undefined && typeof project.path !== 'string') {
    throw new Error(`${scriptPath}: project.path must be a string when supplied`);
  }
  if (!Array.isArray(script.steps)) throw new Error(`${scriptPath}: steps must be an array`);
  for (const [index, step] of script.steps.entries())
    validateStep(step, `${scriptPath}: steps[${index}]`);
}

function validateStep(step, label) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`${label} must be an object`);
  }
  if (step.expect !== undefined) {
    if (!step.expect || typeof step.expect !== 'object' || Array.isArray(step.expect)) {
      throw new Error(`${label}.expect must be an object`);
    }
    for (const [surface, operator] of Object.entries(step.expect)) {
      if (surface !== 'telegram' && surface !== 'transcript') {
        throw new Error(`${label}.expect has unknown surface ${surface}`);
      }
      if (typeof operator !== 'string')
        throw new Error(`${label}.expect.${surface} must be a string`);
      const isMatchTranscript = surface === 'telegram' && operator === 'match:transcript';
      if (
        !operator.startsWith('contains:') &&
        !operator.startsWith('turns:') &&
        !isMatchTranscript
      ) {
        const supported =
          surface === 'telegram' ? 'contains:, turns:, or match:transcript' : 'contains: or turns:';
        const scope =
          operator === 'match:transcript'
            ? ' (match:transcript is only supported on telegram)'
            : '';
        throw new Error(`${label}.expect.${surface} must use ${supported}${scope}`);
      }
    }
    return;
  }
  if (step.via === 'open') {
    if (step.prompt !== undefined && typeof step.prompt !== 'string') {
      throw new Error(`${label}.prompt must be a string when supplied`);
    }
    return;
  }
  if (step.via === 'bind') {
    if (typeof step.text !== 'string') throw new Error(`${label}.text must be a string`);
    return;
  }
  if (step.via === 'telegram') {
    if (typeof step.text !== 'string') throw new Error(`${label}.text must be a string`);
    return;
  }
  if (step.via === 'terminal') {
    const hasText = typeof step.text === 'string';
    const hasKeys = Array.isArray(step.keys);
    if (hasText === hasKeys) throw new Error(`${label} needs exactly one of text or keys`);
    if (hasKeys && step.keys.some((key) => typeof key !== 'string')) {
      throw new Error(`${label}.keys must contain strings`);
    }
    return;
  }
  if (step.via === 'reap') return;
  throw new Error(`${label}.via must be telegram, terminal, open, bind, or reap`);
}
