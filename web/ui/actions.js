import { eventClock } from '../lib/time.js';

export function createActions({
  client,
  elements,
  projects,
  sessions,
  state,
  getSelectedStreamId,
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
  const openSession = async () => {
    const provider = elements.harness.value.trim();
    const prompt = elements.prompt.value.trim();
    const cwd = projects.selectedPath();
    if (!provider || !prompt) {
      appendError('default harness and prompt are required');
      return;
    }
    if (cwd) projects.remember(cwd);
    state.opening = true;
    setStatus('OPENING', 'wait');
    refreshControls();
    try {
      const result = await client.openSession({ provider, prompt, ...(cwd ? { cwd } : {}) });
      const entry = ensureEntry(result.stream_id, provider);
      if (!entry) throw new Error('session.open returned an invalid stream');
      entry.session_id = result.session_id;
      entry.cwd = cwd;
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
    entry.busy = true;
    setStatus('SENDING', 'wait');
    refreshControls();
    try {
      if (entry.resume) {
        const result = await client.resumeSession({
          source: entry.resume.source,
          ref: entry.resume.ref,
          prompt,
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
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

  const runWorkflow = async () => {
    const template = elements.workflowTemplate.value.trim();
    if (!template) {
      appendError('workflow template is required');
      return;
    }
    state.running = true;
    setStatus('STARTING WORKFLOW', 'wait');
    refreshControls();
    try {
      const result = await client.runWorkflow({ template });
      const entry = ensureEntry(result.stream_id, template);
      if (!entry) throw new Error('workflow.run returned an invalid stream');
      selectStream(result.stream_id);
      setStatus('LIVE', 'live');
    } catch (error) {
      appendError(`workflow run failed: ${errorMessage(error)}`);
      setStatus('ERROR', 'bad');
    } finally {
      state.running = false;
      refreshControls();
    }
  };

  const approveWorkflow = async () => {
    const entry = sessions.get(getSelectedStreamId());
    if (!entry || entry.kind !== 'workflow' || entry.status !== 'running') return;
    const streamId = entry.stream_id;
    state.approving = true;
    setStatus('APPROVING', 'wait');
    refreshControls();
    try {
      const result = await client.approve({ stream_id: streamId });
      if (result.status === 'released' || result.stage === 'release') entry.status = 'done';
      const tone = result.approved ? 'ok' : result.blocked ? 'wait' : 'bad';
      const reason = result.reason ? ` · ${result.reason}` : '';
      const detail = `${result.status} · ${result.stage}${reason}`;
      pushLine(entry, tone, `${eventClock(new Date().toISOString())} workflow.approve · ${detail}`);
      setStatus(result.blocked ? 'WAITING' : 'LIVE', result.blocked ? 'wait' : 'live');
    } catch (error) {
      appendError(`workflow approval failed: ${errorMessage(error)}`, entry);
      setStatus('APPROVAL ERROR', 'bad');
    } finally {
      state.approving = false;
      renderSwitcher();
      refreshControls();
    }
  };

  return { openSession, sendMessage, stopSession, runWorkflow, approveWorkflow };
}
