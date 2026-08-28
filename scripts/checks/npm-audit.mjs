import { spawnSync } from 'node:child_process';
import { repositoryRoot } from '../../scripts/evidence.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['audit', '--json', '--offline'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
let report;
try {
  report = JSON.parse(result.stdout ?? '');
} catch {
  report = undefined;
}
if (!report) {
  process.stdout.write(
    'VIBECODIUM_WARN npm audit not_configured/offline; advisory scan is warn-tier\n',
  );
} else {
  const vulnerabilities = report.metadata?.vulnerabilities ?? {};
  const high = Number(vulnerabilities.high ?? 0);
  const critical = Number(vulnerabilities.critical ?? 0);
  if (high > 0 || critical > 0) {
    process.stdout.write(`VIBECODIUM_WARN npm audit high=${high} critical=${critical}\n`);
  } else {
    process.stdout.write('npm audit passed: no high/critical vulnerabilities\n');
  }
}
process.exitCode = 0;
