import { postCommand } from '../lib/command.js';
import { isExternalEntry } from '../lib/external-session.js';
import { sessionIdOf } from '../lib/session-items.js';
import { eventClock } from '../lib/time.js';

export function createActions({
  client,
  elements,
  sessions,
  state,
  getSelectedStreamId,
  getActiveProject,
  getModel,
  connection,
  resetInput,
  getPrompt,
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
  const queuedSends = [];
  let flushingQueuedSends = false;

  const setUnavailableStatus = () => {
    const online = browserOnline();
    setStatus(online ? 'RECONNECTING' : 'OFFLINE', online ? 'wait' : 'bad');
  };

  const queueSend = (entry, prompt) => {
    const line = pushLine(
      entry,
      'wait',
      `${eventClock(new Date().toISOString())} queued - sending on reconnect · ${prompt}`,
      false,
      { queued: true },
    );
    queuedSends.push({ entry, prompt, line });
    if (getSelectedStreamId() === entry.stream_id) setUnavailableStatus();
  };

  const flushQueuedSends = async () => {
    if (flushingQueuedSends || !queuedSends.length) return;
    flushingQueuedSends = true;
    try {
      while (queuedSends.length) {
        const pending = queuedSends[0];
        pending.entry.busy = true;
        renderSessions();
        let delivered = false;
        let lastError;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const sessionId = sessionIdOf(pending.entry);
            if (!sessionId) throw new Error('session id unavailable');
            await client.sendMessage({ session_id: sessionId, prompt: pending.prompt });
            delivered = true;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        queuedSends.shift();
        if (delivered) {
          pending.line.cls = 'meta';
          pending.line.text = pending.line.text.replace(
            'queued - sending on reconnect',
            'sent on reconnect',
          );
        } else {
          pending.entry.busy = false;
          pending.line.cls = 'bad';
          pending.line.text = `${eventClock(new Date().toISOString())} queued send failed after retry · ${errorMessage(
            lastError,
          )}`;
          appendError(`queued send failed after retry: ${errorMessage(lastError)}`, pending.entry);
          if (isTransportFailure(lastError)) setUnavailableStatus();
          else setStatus('ERROR', 'bad');
          refreshControls();
          renderStream();
          break;
        }
        refreshControls();
        renderStream();
      }
    } finally {
      flushingQueuedSends = false;
    }
  };

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
      // `origin` is what separates the operator's own sessions from the ones agents open; the
      // composer is the operator by definition. `model` only rides along when a preset is chosen,
      // so the harness keeps its own default otherwise.
      const openArgs = { provider, prompt, origin: 'operator' };
      if (cwd) openArgs.cwd = cwd;
      if (projectName) openArgs.project = projectName;
      const model = getModel();
      if (model) openArgs.model = model;
      const result = await client.openSession(openArgs);
      const entry = ensureEntry(result.stream_id, provider);
      if (!entry) throw new Error('session.open returned an invalid stream');
      entry.session_id = result.session_id;
      entry.cwd = cwd || '';
      entry.project = projectName || '';
      entry.origin = 'operator';
      entry.busy = true;
      resetInput();
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

  // Resolves to `sent` only when the turn actually reached the harness. A transport failure is
  // accepted into the local queue and resolves to `queued`, so the caller can clear its draft.
  const sendTurn = async (entry, prompt) => {
    entry.busy = true;
    renderSessions();
    try {
      const sessionId = sessionIdOf(entry);
      if (!sessionId) throw new Error('session id unavailable');
      await client.sendMessage({ session_id: sessionId, prompt });
      return 'sent';
    } catch (error) {
      entry.busy = false;
      if (isTransportFailure(error)) {
        queueSend(entry, prompt);
        return 'queued';
      }
      appendError(`session send failed: ${errorMessage(error)}`, entry);
      if (getSelectedStreamId() === entry.stream_id) setStatus('ERROR', 'bad');
      return 'failed';
    } finally {
      refreshControls();
      renderStream();
    }
  };

  // Native control keys: the harness owns queue and steer semantics, so the phone only presses
  // the same keys a person at the PC would. An interrupt stays pending until the event stream
  // reports the turn boundary, so the button cannot queue duplicate aborts.
  const sendKeys = async (entry, keys, pendingKey) => {
    if (!entry || !isSendable(entry)) {
      notify('select a live session first');
      return;
    }
    const sessionId = sessionIdOf(entry);
    if (!sessionId) {
      appendError('session id unavailable', entry);
      return;
    }
    if (pendingKey) {
      state[pendingKey] = true;
      refreshControls();
    }
    let holdPending = false;
    try {
      const result = await client.sessionSendKeys({ session_id: sessionId, keys });
      holdPending = pendingKey === 'interrupting';
      notify(`${result.sent} control key${result.sent === 1 ? '' : 's'} sent`);
    } catch (error) {
      const message =
        pendingKey === 'interrupting'
          ? `STOP failed · ${errorMessage(error)}`
          : `control key failed · ${errorMessage(error)}`;
      notify(message, 'bad');
      if (isTransportFailure(error)) setUnavailableStatus();
      else setStatus('ERROR', 'bad');
      if (pendingKey && !holdPending) {
        state[pendingKey] = false;
        refreshControls();
      }
    }
  };

  // One input, three verbs: send into the selected live session, continue the selected machine
  // session in place, or open a new one.
  const submitCompose = async () => {
    const prompt = getPrompt();
    if (!prompt) {
      appendError('a prompt is required');
      return;
    }
    const entry = sessions.get(getSelectedStreamId());
    if (entry && isSendable(entry)) {
      if (entry.busy) return;
      const result = await sendTurn(entry, prompt);
      if (result === 'sent' || result === 'queued') resetInput();
      return;
    }
    if (entry && isExternalEntry(entry)) {
      if (state.resuming) return;
      await continueExternalSession(entry, prompt);
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

  // A mid-session model change is the harness's own slash command, not a control-plane verb: it
  // rides the ordinary send path so the session records it exactly like a typed message would.
  const switchModel = async (model) => {
    const entry = sessions.get(getSelectedStreamId());
    if (!model) {
      notify('model preset cleared · applies to the next session');
      return;
    }
    if (!entry || !isSendable(entry) || !sessionIdOf(entry) || entry.busy) {
      notify(`model ${model} · applies to the next session`);
      return;
    }
    const result = await sendTurn(entry, `/model ${model}`);
    if (result === 'sent') notify(`model switch sent · /model ${model}`);
    else if (result === 'queued') notify(`model switch queued · sending on reconnect`);
  };

  // session.rename is newer than the bundled SDK, so it goes over the raw command wire. An older
  // control plane answers with an error the owner can read instead of a pill stuck mid-edit.
  const renameSession = async (item, label) => {
    const sessionId = item.session_id || sessionIdOf(sessions.get(item.stream_id));
    if (!sessionId) {
      appendError('this session cannot be renamed');
      renderSessions();
      return;
    }
    try {
      const { baseUrl, token } = connection();
      const result = await postCommand(
        'session.rename',
        { session_id: sessionId, label },
        { baseUrl, token },
      );
      const entry = sessions.get(item.stream_id);
      if (entry) entry.sessionLabel = result?.label ?? label;
      notify(label ? `renamed · ${result?.label ?? label}` : 'session label cleared');
      void reloadSessions();
    } catch (error) {
      appendError(`session rename failed: ${errorMessage(error)}`);
    } finally {
      renderSessions();
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
      const message = `STOP failed · ${errorMessage(error)}`;
      notify(message, 'bad');
      if (isTransportFailure(error)) setUnavailableStatus();
      else setStatus('ERROR', 'bad');
    } finally {
      state.stopping = false;
      renderSessions();
      refreshControls();
    }
  };

  // The machine owns an external session, so the phone holds it read-only until the operator
  // actually writes something. That first message continues the very same session — session.resume
  // reopens the machine's own transcript and appends to it — and the read-only view goes live.
  //
  // Nothing is written on failure, not even the typed text: the composer keeps it, so a control
  // plane that refuses because the laptop is still working in that session costs one more tap.
  const continueExternalSession = async (entry, prompt) => {
    if ((entry.label !== 'omp' && entry.label !== 'codex') || !entry.ref) {
      appendError('this external session cannot be continued', entry);
      return;
    }
    state.resuming = true;
    setStatus('CONTINUING', 'wait');
    refreshControls();
    try {
      // cwd and project are left to the control plane: it resolves the machine session's own
      // directory, which is the only place this transcript may legally be continued.
      const result = await client.resumeSession({
        source: entry.label,
        ref: entry.ref,
        prompt,
        origin: 'operator',
      });
      const live = ensureEntry(result.stream_id, entry.label);
      if (!live) throw new Error('session.resume returned an invalid stream');
      live.session_id = result.session_id;
      live.cwd = entry.cwd || '';
      live.project = entry.project || '';
      live.origin = 'operator';
      live.busy = true;
      // The read-only lines lead, so the operator keeps the context they were just reading. Lines
      // the event feed already delivered for the live stream stay after them, in order.
      live.lines = [...entry.lines, ...live.lines];
      sessions.delete(entry.stream_id);
      pushLine(
        live,
        'ok',
        `${eventClock(new Date().toISOString())} continued ${entry.label} ${entry.ref} in place`,
      );
      resetInput();
      selectStream(result.stream_id);
      setStatus('LIVE', 'live');
      void reloadSessions();
    } catch (error) {
      appendError(`session continue failed: ${errorMessage(error)}`, entry);
      setStatus('ERROR', 'bad');
    } finally {
      state.resuming = false;
      renderSessions();
      refreshControls();
    }
  };

  return {
    submitCompose,
    openPreset,
    stopSession,
    sendKeys,
    switchModel,
    renameSession,
    flushQueuedSends,
  };
}

function isSendable(entry) {
  return entry.kind === 'session' && (entry.status === 'running' || entry.status === 'ready');
}

function browserOnline() {
  return globalThis.navigator?.onLine !== false;
}

function isTransportFailure(error) {
  if (error instanceof TypeError) return true;
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('unreachable') ||
    message.includes('connection refused') ||
    message.includes('connection reset') ||
    message.includes('err_connection') ||
    message.includes('econnrefused') ||
    message.includes('service unavailable') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout') ||
    /\bhttp\s+5\d{2}\b/.test(message)
  );
}
