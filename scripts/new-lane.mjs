import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GIT = '/usr/bin/git';
const ALLOWED_TYPES = new Set(['build', 'fix', 'feat', 'chore', 'docs']);
const USAGE = `usage: scripts/new-lane [type] <N> [slug]
       scripts/new-lane <N> [slug]  (type defaults to feat)

type: build, fix, feat, chore, or docs
N: a positive integer issue number
slug: optional; non-ASCII and punctuation are replaced with '-'
`;

function usageError(message) {
  process.stderr.write(`error: ${message}\n${USAGE}`);
  return 2;
}

function isPositiveInteger(value) {
  if (!/^[0-9]+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
}

export function sanitizeSlug(value) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseArguments(args) {
  if (args.length < 1 || args.length > 3) {
    return { error: usageError('expected [type] <N> [slug]') };
  }

  const first = args[0];
  let type = 'feat';
  let numberText = first;
  let slugText;
  if (ALLOWED_TYPES.has(first)) {
    type = first;
    numberText = args[1];
    slugText = args[2];
    if (!numberText) return { error: usageError('issue number is required') };
  } else if (isPositiveInteger(first)) {
    if (args.length > 2) return { error: usageError('expected [type] <N> [slug]') };
    slugText = args[1];
  } else if (args.length === 2 && !isPositiveInteger(args[1])) {
    slugText = args[1];
  } else if (args.length > 1) {
    return {
      error: usageError(
        `type must be one of build, fix, feat, chore, or docs (received '${first}')`,
      ),
    };
  } else {
    return {
      error: usageError(`issue number must be a positive integer (received '${numberText ?? ''}')`),
    };
  }

  if (!numberText || !isPositiveInteger(numberText)) {
    return {
      error: usageError(`issue number must be a positive integer (received '${numberText ?? ''}')`),
    };
  }

  const number = String(Number(numberText));
  const slug = slugText === undefined ? '' : sanitizeSlug(slugText);
  if (slugText !== undefined && !slug) {
    return {
      error: usageError('slug is empty after sanitization; provide letters, digits, or hyphens'),
    };
  }

  const branch = `${type}/${number}${slug ? `-${slug}` : ''}`;
  return { type, number, slug, branch };
}

function realpathForTarget(target) {
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing) {
    try {
      return fs.realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  }
  return path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
}

function isNested(root, target) {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedTarget = realpathForTarget(target);
  return resolvedTarget !== resolvedRoot && resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function branchExists(root, branch) {
  const result = spawnSync(
    GIT,
    ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    {
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr?.trim() || `git show-ref exited with status ${result.status}`);
}

function mainTip(root) {
  try {
    return execFileSync(GIT, ['-C', root, 'rev-parse', '--verify', 'main^{commit}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    throw new Error(detail || 'could not resolve main tip');
  }
}

function runGit(root, args) {
  const result = spawnSync(GIT, ['-C', root, ...args], { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} exited with status ${result.status}`);
}

function shellPath(value) {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function cleanup(root, target, branch) {
  try {
    runGit(root, ['worktree', 'remove', '--force', target]);
  } catch (error) {
    process.stderr.write(
      `warning: could not remove failed worktree ${target}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  try {
    runGit(root, ['branch', '-D', branch]);
  } catch (error) {
    process.stderr.write(
      `warning: could not remove failed branch ${branch}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export function createLane(args = process.argv.slice(2)) {
  const parsed = parseArguments(args);
  if ('error' in parsed) return parsed.error;

  const scriptPath = fileURLToPath(import.meta.url);
  const root = fs.realpathSync(path.resolve(path.dirname(scriptPath), '..'));
  const parent = path.dirname(root);
  const branchSafe = parsed.branch.replaceAll('/', '-');
  const target = path.join(parent, `${path.basename(root)}-wt-${branchSafe}`);

  if (isNested(root, target))
    return usageError(`target path would be nested inside the repository: ${target}`);
  if (branchExists(root, parsed.branch)) {
    process.stderr.write(`error: branch '${parsed.branch}' already exists\n`);
    return 1;
  }
  if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
    process.stderr.write(`error: worktree path already exists: ${target}\n`);
    return 1;
  }

  let tip;
  try {
    tip = mainTip(root);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    runGit(root, ['worktree', 'add', '-b', parsed.branch, target, tip]);
  } catch (error) {
    process.stderr.write(
      `error: unable to create branch/worktree '${parsed.branch}' at '${target}': ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  try {
    const nodeModules = path.join(root, 'node_modules');
    const nodeModulesStats = fs.statSync(nodeModules, { throwIfNoEntry: false });
    if (nodeModulesStats?.isDirectory()) {
      const linked = spawnSync('cp', ['-al', nodeModules, path.join(target, 'node_modules')], {
        encoding: 'utf8',
      });
      if (linked.stdout) process.stdout.write(linked.stdout);
      if (linked.status === 0) process.stdout.write(`linked node_modules into ${target}\n`);
      else {
        if (linked.stderr) process.stderr.write(linked.stderr);
        process.stderr.write(
          `warning: could not hardlink node_modules into ${target}; continuing\n`,
        );
      }
    } else {
      process.stderr.write(`note: ${nodeModules} is absent; skipping hardlink\n`);
    }

    const initialized = spawnSync(process.execPath, ['scripts/branch-init.mjs', parsed.number], {
      cwd: target,
      env: { ...process.env },
      stdio: 'inherit',
    });
    if (initialized.error || initialized.status !== 0) {
      cleanup(root, target, parsed.branch);
      process.stderr.write(
        `error: branch initialization failed for ${parsed.branch}: ${initialized.error?.message ?? `status ${initialized.status}`}\n`,
      );
      return initialized.status && initialized.status > 0 ? initialized.status : 1;
    }
  } catch (error) {
    cleanup(root, target, parsed.branch);
    process.stderr.write(
      `error: lane setup failed for ${parsed.branch}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `Created lane ${parsed.branch} at ${target}\nNext steps:\n  cd ${shellPath(target)}\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = createLane();
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
