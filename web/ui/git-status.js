import { basename } from '../lib/paths.js';

// The chat heading carries the selected session's branch state; late replies never overwrite it.
export function createGitStatus({ client, target, isCurrent }) {
  let request = 0;

  const hide = () => {
    target.hidden = true;
  };

  const update = async (entry) => {
    const current = ++request;
    if (!entry?.cwd) {
      hide();
      return;
    }
    try {
      const result = await client.workspaceStatus({ path: entry.cwd });
      if (current !== request || !isCurrent(entry)) return;
      if (!result.branch || /no git|not git/i.test(result.branch)) {
        hide();
        return;
      }
      const name = basename(entry.cwd) || entry.cwd;
      const state = result.dirty ? 'dirty' : 'clean';
      target.textContent = `${name} · ${result.branch} · ● ${state}`;
      target.hidden = false;
    } catch {
      if (current === request) hide();
    }
  };

  return { update, hide };
}
