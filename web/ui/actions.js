import { eventClock } from '../lib/time.js';

export function createActions({
  client,
  elements,
  projects,
  sessions,
  state,
  getSelectedStreamId,
  getActiveProject,
  setStatus,
  refreshControls,
  renderSwitcher,
  renderStream,
  selectStream,
  ensureEntry,
  pushLine,
  appendError,
  errorMessage,
}) {
  const openSessionWith = async (prompt, cwd, projectName) => {
    const provider = elements.harness.value.trim();
    if (!provider || !prompt) {
      appendError('default harness and prompt are required');
      return;
    }
    if (cwd) projects.remember(cwd);
    state.opening = true;
    setStatus('OPENING', 'wait');
    refreshControls();
    try {
      const openArgs = { provider, prompt };
      if (cwd) openArgs.cwd = cwd;
      if (projectName) openArgs.project = projectName;
      const result = await client.openSession(openArgs);
      const entry = ensureEntry(result.stream_id, provider);
      if (!entry) throw new Error('session.open returned an invalid stream');
      entry.session_id = result.session_id;
      entry.cwd = cwd || '';
      entry.project = projectName || '';
      entry.busy = true;
      selectStream(result.stream_id);
      setStatus('LIVE', 'live');
      elements.prompt.value = '';
    } catch (error) {
      appendError(`session open failed: ${errorMessage(error)}`);
      setStatus('ERROR', 'bad');
    } finally {
      state.opening = false;
      refreshControls();
    }
  };

  const openSession = async () => {
    const project = getActiveProject();
    const cwd = project?.path || projects.selectedPath();
    return openSessionWith(elements.prompt.value.trim(), cwd, project?.name);
  };

  const openQuickAction = async (project, action) =>
    openSessionWith(action.prompt.trim(), project.path, project.name);

  const sendMessage = async () => {
    const entry = sessions.get(getSelectedStreamId());
    if (
      !entry ||
      entry.kind !== 'session' ||
      (entry.status !== 'running' && entry.status !== 'ready') ||
      entry.busy
    )
      return;
    const prompt = elements.turnInput.value.trim();
    if (!prompt) {
      appendError('message is required', entry);
      return;
    }
    entry.lastActivityAt = Date.now();
    entry.busy = true;
    setStatus('SENDING', 'wait');
    renderSwitcher();
    try {
      if (entry.resume) {
        const result = await client.resumeSession({
          source: entry.resume.source,
          ref: entry.resume.ref,
          prompt,
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
          ...(entry.project ? { project: entry.project } : {}),
        });
        sessions.delete(entry.stream_id);
        entry.stream_id = result.stream_id;
        entry.session_id = result.session_id;
        entry.status = 'running';
        delete entry.resume;
        sessions.set(entry.stream_id, entry);
        selectStream(entry.stream_id);
      } else {
        const sessionId = entry.session_id || entry.stream_id.slice('session:'.length);
        if (!sessionId) throw new Error('session id unavailable');
        await client.sendMessage({ session_id: sessionId, prompt });
      }
      elements.turnInput.value = '';
      if (getSelectedStreamId() === entry.stream_id) setStatus('LIVE', 'live');
    } catch (error) {
      entry.busy = false;
      appendError(`session send failed: ${errorMessage(error)}`, entry);
      if (getSelectedStreamId() === entry.stream_id) setStatus('ERROR', 'bad');
    } finally {
      refreshControls();
      renderStream();
    }
  };

  const stopSession = async () => {
    const entry = sessions.get(getSelectedStreamId());
    if (!entry || entry.kind !== 'session' || entry.status !== 'running') return;
    const sessionId = entry.session_id || entry.stream_id.slice('session:'.length);
    state.stopping = true;
    setStatus('STOPPING', 'wait');
    refreshControls();
    try {
      const result = await client.stopSession({ session_id: sessionId });
      entry.status = 'done';
      const detail = result.stopped
        ? `stopped ${sessionId}`
        : `session ${sessionId} was already stopped`;
      pushLine(
        entry,
        result.stopped ? 'ok' : 'meta',
        `${eventClock(new Date().toISOString())} session.stop · ${detail}`,
      );
      setStatus(getSelectedStreamId() ? 'LIVE' : 'READY', getSelectedStreamId() ? 'live' : 'idle');
    } catch (error) {
      appendError(`session stop failed: ${errorMessage(error)}`, entry);
      setStatus('ERROR', 'bad');
    } finally {
      state.stopping = false;
      renderSwitcher();
      refreshControls();
    }
  };

  return { openSession, openQuickAction, sendMessage, stopSession };
}
