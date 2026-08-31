import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MODEL_COMMAND_TIMEOUT_MS = 15_000;
const MODEL_COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

let modelContextWindows = new Map<string, number>();
let primed = false;
let autoPrimeAttempted = false;
let primePromise: Promise<void> | undefined;
let generation = 0;

export function parseModelCatalog(json: string): Map<string, number> {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return new Map();
  }
  if (!isRecord(value) || !Array.isArray(value.models)) return new Map();

  const catalog = new Map<string, number>();
  for (const entry of value.models) {
    if (!isRecord(entry)) continue;
    const contextWindow = entry.contextWindow;
    if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0)
      continue;
    for (const key of [entry.id, entry.selector]) {
      if (typeof key === 'string' && key.length > 0) catalog.set(key, contextWindow);
    }
  }
  return catalog;
}

export function contextWindowFor(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const contextWindow = modelContextWindows.get(model);
  if (contextWindow !== undefined) return contextWindow;
  if (!primed && !autoPrimeAttempted) {
    autoPrimeAttempted = true;
    void primeModelContextWindows();
  }
  return undefined;
}

export function primeModelContextWindows(run: () => Promise<string> = defaultRun): Promise<void> {
  if (primePromise !== undefined) return primePromise;
  autoPrimeAttempted = true;

  const currentGeneration = generation;
  const promise = (async () => {
    try {
      const catalog = parseModelCatalog(await Promise.resolve().then(run));
      if (currentGeneration !== generation) return;
      modelContextWindows = catalog;
      primed = true;
    } catch {
      if (currentGeneration === generation) {
        modelContextWindows.clear();
        primed = false;
      }
    } finally {
      if (currentGeneration === generation) primePromise = undefined;
    }
  })();
  primePromise = promise;
  return promise;
}

export function resetModelContextWindows(entries?: Iterable<readonly [string, number]>): void {
  generation += 1;
  primePromise = undefined;
  autoPrimeAttempted = false;
  primed = entries !== undefined;
  modelContextWindows = new Map(entries);
}

async function defaultRun(): Promise<string> {
  const { stdout } = await execFileAsync('omp', ['models', '--json'], {
    encoding: 'utf8',
    timeout: MODEL_COMMAND_TIMEOUT_MS,
    maxBuffer: MODEL_COMMAND_MAX_BUFFER,
  });
  return stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
