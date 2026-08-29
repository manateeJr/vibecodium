import { eventClock } from '../lib/time.js';

export function createActions({
  client,
  elements,
  sessions,
  state,
  getSelectedStreamId,
  getActiveProject,
  setStatus,
  refreshControls,
  renderSessions,
  renderStream,
  selectStream,
  ensureEntry,
  pushLine,
  appendError,
  errorMessage,
  notify,
  reloadSessions,
}) {
  const openSessionWith = async (prompt, cwd, projectName) => {
    const provider = elements.harness.value.trim();
    if (!provider || !prompt) {
      appendError('default harness and prompt are required');
      return;
    }
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
      elements.composeInput.value = '';
      selectStream(result.stream_id);
      setStatus('LIVE', 'live');
      void reloadSessions();
    } catch (error) {
      appendError(`session open failed: ${errorMessage(error)}`);
      setStatus('ERROR', 'bad');
    } finally {
      state.opening = false;
      refreshControls();
    }
  };

  const sendTurn = async (entry, prompt) => {
    entry.lastActivityAt = Date.now();
    entry.busy = true;
    setStatus('SENDING', 'wait');
    renderSessions();
    try {
      const sessionId = entry.session_id || entry.stream_id.slice('session:'.length);
      if (!sessionId) throw new Error('session id unavailable');
      await client.sendMessage({ session_id: sessionId, prompt });
      elements.composeInput.value = '';
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

  // One input, two verbs: send into the selected live session, otherwise open a new one.
  const submitCompose = async () => {
    const prompt = elements.composeInput.value.trim();
    if (!prompt) {
      appendError('a prompt is required');
      return;
    }
    const entry = sessions.get(getSelectedStreamId());
    if (entry && isSendable(entry)) {
      if (entry.busy) return;
      await sendTurn(entry, prompt);
      return;
    }
    const project = getActiveProject();
    await openSessionWith(
      prompt,
      entry?.cwd || project?.path || '',
      entry?.project || project?.name || '',
    );
  };

  const openPreset = async (preset) => {
    const project = getActiveProject();
    await openSessionWith(preset.prompt.trim(), project?.path, project?.name);
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
      renderSessions();
      refreshControls();
    }
  };

  // External harness sessions are forked, never appended to: the laptop still owns the original.
  const forkMachineSession = async (session) => {
    const streamId = `machine:${session.source}:${session.ref}`;
    if (sessions.has(streamId)) {
      selectStream(streamId);
      return;
    }
    state.forking = true;
    setStatus('FORKING', 'wait');
    refreshControls();
    try {
      const result = await client.forkSession({ session_id: session.ref });
      const entry = machineEntry(session, streamId);
      sessions.set(streamId, entry);
      const clock = eventClock(new Date().toISOString());
      pushLine(
        entry,
        'ok',
        `${clock} resumed as a fork · ${result.new_session_id} · ${result.provider}`,
      );
      pushLine(
        entry,
        'meta',
        `continue this fork on the laptop:\n\n\`\`\`\n${result.continue_command}\n\`\`\``,
        true,
      );
      selectStream(streamId);
      notify(`resumed as a fork · ${result.new_session_id}`);
      setStatus('READY', 'idle');
    } catch (error) {
      appendError(`session fork failed: ${errorMessage(error)}`);
      setStatus('ERROR', 'bad');
    } finally {
      state.forking = false;
      renderSessions();
      refreshControls();
    }
  };

  return { submitCompose, openPreset, stopSession, forkMachineSession };
}

function isSendable(entry) {
  return entry.kind === 'session' && (entry.status === 'running' || entry.status === 'ready');
}

function machineEntry(session, streamId) {
  const updatedAt = Date.parse(session.updated_at ?? '');
  return {
    stream_id: streamId,
    kind: 'session',
    label: session.source,
    status: 'done',
    busy: false,
    lines: [],
    cwd: session.cwd || '',
    project: '',
    updated_at: session.updated_at,
    lastActivityAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}
