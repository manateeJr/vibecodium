import { spawnSync } from 'node:child_process';

const SYSTEMCTL_COMMAND = 'systemctl';

export function stopSubstrateScope(name: string, enabled: boolean, timeoutMs: number): void {
  if (!enabled) return;
  spawnSync(SYSTEMCTL_COMMAND, ['--user', 'stop', `vibecodium-session-${name}.scope`], {
    stdio: 'ignore',
    timeout: timeoutMs,
  });
}
