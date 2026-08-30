// The one affordance a finished, failed or machine-owned session still offers: open a new session
// where that one was. Selecting a session never moves the scope — the project belongs to the owner,
// not to whatever they last tapped — so this is the single place the context is allowed to move,
// and the button says which project it moves to before it is pressed.
export function createRestartAction({ elements, getProject, selectProject, showTransient }) {
  const prepare = (entry) => {
    const target = entry.project || '';
    if (target && target !== getProject()) {
      selectProject(target);
      showTransient('meta', `project switched to ${target} · you asked for this session`);
    }
    elements.composeInput.focus();
    elements.composeInput.scrollIntoView?.({ block: 'nearest' });
    showTransient(
      'meta',
      `new session ready · ${entry.cwd || '(default cwd)'} · harness ${elements.harness.value}`,
    );
  };

  return (entry) => {
    const restartable =
      entry.kind === 'session' &&
      (entry.status === 'done' || entry.status === 'failed' || entry.status === 'external');
    if (!restartable) return undefined;
    const target = entry.project || '';
    return {
      label:
        target && target !== getProject()
          ? `Open new session in ${target}`
          : 'Open new session here',
      run: () => prepare(entry),
    };
  };
}
