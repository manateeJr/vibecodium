import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repositoryRoot, 'vibecodium.quality.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const maxFileLines = manifest.maxFileLines;
const exemptPatterns = manifest.maxFileLinesExempt ?? [];
const textExtensions = new Set([
  '.bash',
  '.cjs',
  '.css',
  '.env',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.md',
  '.mjs',
  '.sh',
  '.sql',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.toml',
  '.xml',
  '.yaml',
  '.yml',
]);
const textBasenames = new Set(['.gitattributes', '.gitignore', '.npmrc', 'Dockerfile', 'Makefile']);

if (!Number.isInteger(maxFileLines) || maxFileLines < 1) {
  process.stderr.write(
    'not_configured: quality manifest maxFileLines must be a positive integer\n',
  );
  process.exit(2);
}

function globToRegExp(pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      expression += '.*';
      index += 1;
    } else if (character === '*') {
      expression += '[^/]*';
    } else {
      expression += '\\^$+?.()|{}[]'.includes(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`^${expression}$`);
}

const exemptRegexes = exemptPatterns.map((pattern) => globToRegExp(pattern));
function isExempt(file) {
  return exemptRegexes.some((regex) => regex.test(file));
}

function isTextFile(file, content) {
  if (content.includes('\u0000')) return false;
  const basename = path.posix.basename(file);
  return (
    textBasenames.has(basename) ||
    textExtensions.has(path.posix.extname(file).toLowerCase()) ||
    !path.posix.extname(file)
  );
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

function stagedFiles() {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  return output.split('\0').filter(Boolean);
}

const files = process.argv.includes('--staged') ? stagedFiles() : trackedFiles();
const offenders = [];
for (const file of files) {
  if (isExempt(file)) continue;
  const fullPath = path.join(repositoryRoot, file);
  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    process.stderr.write(
      `failed: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    continue;
  }
  if (!isTextFile(file, content)) continue;
  const lines = content.length === 0 ? 0 : content.split('\n').length;
  if (lines > maxFileLines) offenders.push(`${file}: ${lines} lines (max ${maxFileLines})`);
}

if (offenders.length > 0) {
  process.stderr.write(`max-file-lines failed:\n${offenders.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `max-file-lines passed: ${files.length} tracked candidate(s), max ${maxFileLines}\n`,
  );
}
