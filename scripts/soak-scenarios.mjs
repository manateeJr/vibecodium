import * as fs from 'node:fs';

export async function runScenario({
  options,
  state,
  soak,
  substrateReady,
  projectDir,
  machineRoot,
  runPhase,
  openRecordedSession,
  stopRecordedSession,
  sendTurn,
  waitForEvents,
  readEvents,
  command,
  recordValue,
  readJson,
  stopRuntime,
  startRuntime,
  sleep,
  log,
}) {
  state.recordedSessionIds = new Set();
  state.stopped = false;
  const closeSubstrateSession = async (sessionId, streamId, substrateName) => {
    await stopRecordedSession(sessionId, streamId, true);
    const record = state.runtime?.table.get(sessionId);
    if (record && record.state !== 'closed') state.runtime.table.updateState(sessionId, 'closed');
    state.substrateNames.delete(substrateName);
  };
  const stopSession = async () => {
    if (state.stopped || !state.sessionId || !state.streamId) return;
    await closeSubstrateSession(state.sessionId, state.streamId, `substrate-${state.sessionId}`);
    state.stopped = true;
  };
  await runPhase('open', async () => {
    const opened = await openRecordedSession(
      options.provider,
      `SOAK-OPEN-${state.cycle}: reply with this marker and do not use tools`,
    );
    state.sessionId = opened.session_id;
    state.streamId = opened.stream_id;
  });
  await runPhase('multi-turn', async () => {
    await sendTurn(`SOAK-TURN-${state.cycle}-2: reply with this marker only`);
    await sendTurn(`SOAK-TURN-${state.cycle}-3: reply with this marker only`);
    await sendTurn(`SOAK-TURN-${state.cycle}-4: reply with this marker only`);
  });
  await runPhase('steering', async () => {
    if (options.provider === 'fake') {
      log('phase steering SKIP provider=fake (no persistent terminal)');
      return;
    }
    const base = recordValue(
      await command('session.send', {
        session_id: state.sessionId,
        prompt: 'SOAK-STEERING-BASE: reason about this marker before replying. '.repeat(120),
      }),
      'session.send',
    );
    if (typeof base.turn !== 'number') throw new Error('steering base turn missing');
    await waitForEvents(
      (events) =>
        events.some(
          (event) =>
            event?.type === 'session_input' &&
            event.payload?.turn === base.turn &&
            event.payload?.steering !== true &&
            String(event.payload?.text ?? '').includes('SOAK-STEERING-BASE'),
        ),
      'base steering prompt input',
    );
    const keys = recordValue(
      await command('session.send_keys', { session_id: state.sessionId, keys: ['escape'] }),
      'session.send_keys',
    );
    if (keys.sent !== 1) throw new Error('steering key was not sent');
    const steering = recordValue(
      await command('session.send', {
        session_id: state.sessionId,
        prompt: 'SOAK-STEERING-INJECTED: prefer this marker in the current turn',
      }),
      'session.send',
    );
    if (steering.turn !== base.turn)
      throw new Error(`steering was not mid-turn (base=${base.turn}, injected=${steering.turn})`);
    const events = await waitForEvents(
      (items) =>
        items.some(
          (event) => event?.type === 'turn_complete' && event.payload?.turn === base.turn,
        ) &&
        items.some(
          (event) =>
            event?.type === 'session_input' &&
            event.payload?.steering === true &&
            String(event.payload?.text ?? '').includes('SOAK-STEERING-INJECTED'),
        ),
      'mid-turn steering input and completion',
    );
    if (!events.some((event) => event?.payload?.steering === true))
      throw new Error('steering input was not persisted');
  });
  await runPhase('send_keys', async () => {
    if (options.provider === 'fake') {
      log('phase send_keys SKIP provider=fake (no persistent terminal)');
      return;
    }
    const info = recordValue(
      await command('session.attach_info', { session_id: state.sessionId }),
      'session.attach_info',
    );
    if (info.state !== 'live' || typeof info.substrate_name !== 'string')
      throw new Error('attach info did not report a live substrate');
    const listed = await state.runtime.substrate.listSessions();
    if (!listed.some((session) => session.name === info.substrate_name && session.live))
      throw new Error('abduco -l did not report the live substrate');
    await state.runtime.substrate.write(
      info.substrate_name,
      new globalThis.TextEncoder().encode('SOAK-PC-TYPED-AND-CLEARED'),
    );
    await state.runtime.substrate.sendKey(info.substrate_name, 'ctrl_u');
    const keys = recordValue(
      await command('session.send_keys', { session_id: state.sessionId, keys: ['escape'] }),
      'session.send_keys',
    );
    if (keys.sent !== 1) throw new Error('warm send_keys injection was not acknowledged');
    await sendTurn('SOAK-WARM-INJECTION: reply with this marker only');
  });
  await runPhase('share-intake', async () => {
    const fileName = 'soak-shared.txt';
    const content = 'SOAK-SHARE-RIDE-ALONG\n';
    const form = new globalThis.FormData();
    form.append('file', new globalThis.Blob([content], { type: 'text/plain' }), fileName);
    form.append('note', 'SOAK-SHARE-NOTE');
    form.append('project', 'soak-project');
    const staged = recordValue(
      await readJson(
        await globalThis.fetch(`${state.runtime.address.httpUrl}/share-intake`, {
          method: 'POST',
          body: form,
        }),
        'share-intake',
      ),
      'share-intake',
    );
    if (typeof staged.token !== 'string' || !staged.token)
      throw new Error('share-intake omitted token');
    const metadata = recordValue(
      await command('files.shared_staged', { token: staged.token }),
      'files.shared_staged',
    );
    if (metadata.note !== 'SOAK-SHARE-NOTE' || metadata.project !== 'soak-project')
      throw new Error('shared note/project metadata did not round-trip');
    if (!Array.isArray(metadata.files) || metadata.files.length !== 1)
      throw new Error('share-intake did not stage exactly one file');
    const sharedFile = recordValue(metadata.files[0], 'shared file');
    if (sharedFile.name !== fileName || fs.readFileSync(sharedFile.path, 'utf8') !== content)
      throw new Error('shared file content did not round-trip');
    const uploaded = recordValue(
      await command('files.upload', {
        session_id: state.sessionId,
        name: fileName,
        content_base64: globalThis.Buffer.from(content).toString('base64'),
        mime: 'text/plain',
      }),
      'files.upload',
    );
    if (fs.readFileSync(uploaded.path, 'utf8') !== content)
      throw new Error('composer upload did not preserve shared file content');
    await sendTurn('SOAK-SHARE-RIDE-ALONG: continue with the staged note and file');
  });
  await runPhase('rename/recent', async () => {
    state.label = `soak-${process.pid}-${Date.now()}`;
    const renamed = recordValue(
      await command('session.rename', { session_id: state.sessionId, label: state.label }),
      'session.rename',
    );
    if (renamed.label !== state.label) throw new Error('session.rename returned the wrong label');
    const recent = recordValue(
      await command('session.recent', { limit: 1000, include_ended: true }),
      'session.recent',
    );
    const row = recent.sessions?.find((session) => session.session_id === state.sessionId);
    if (!row || row.label !== state.label || row.origin !== 'operator')
      throw new Error('session.recent did not expose the renamed operator session');
  });
  await runPhase('restart-survival', async () => {
    const completed = await openRecordedSession(options.provider, 'SOAK-RESTART-COMPLETED');
    const eventOnly = await openRecordedSession(options.provider, 'SOAK-RESTART-EVENT-ONLY');
    const ids = [...state.recordedSessionIds];
    await closeSubstrateSession(
      completed.session_id,
      completed.stream_id,
      `substrate-${completed.session_id}`,
    );
    const markerPrompt = `SOAK-RESTART-MARKER-${state.cycle}`;
    await sendTurn(markerPrompt);
    const before = await readEvents();
    const marker = before.find(
      (event) => event?.type === 'session_input' && event.payload?.text === markerPrompt,
    );
    if (!marker) throw new Error('restart marker input was not persisted before restart');
    if (options.provider === 'fake') {
      await stopRecordedSession(state.sessionId, state.streamId);
      await stopRecordedSession(eventOnly.session_id, eventOnly.stream_id);
      state.stopped = true;
    }
    const oldRuntime = state.runtime;
    await stopRuntime(oldRuntime);
    state.runtime = await startRuntime(options.provider === 'omp');
    if (options.provider === 'omp')
      await closeSubstrateSession(
        eventOnly.session_id,
        eventOnly.stream_id,
        `substrate-${eventOnly.session_id}`,
      );
    const recent = recordValue(
      await command('session.recent', {
        limit: Math.max(1000, ids.length + 10),
        include_ended: true,
      }),
      'session.recent',
    );
    soak.assertRestartSurvival(ids, recent.sessions ?? []);
    const replayed = await readEvents(marker.stream_id);
    soak.assertEventSurvivedRestart(marker, replayed);
    log(`restart-survival sessions=${ids.length} marker_seq=${marker.seq}`);
  });
  await runPhase('status-accuracy', async () => {
    if (!substrateReady) {
      log('phase status-accuracy SKIP abduco binary unavailable');
      return;
    }
    const provider = options.provider === 'fake' ? 'omp' : options.provider;
    const live = await openRecordedSession(provider, 'SOAK-STATUS-LIVE');
    const resumable = await openRecordedSession(provider, 'SOAK-STATUS-RESUMABLE');
    const liveName = `substrate-${live.session_id}`;
    const resumableName = `substrate-${resumable.session_id}`;
    state.substrateNames.add(liveName);
    state.substrateNames.add(resumableName);
    await state.runtime.substrate.kill(resumableName);
    state.runtime.table.updateState(resumable.session_id, 'resumable');
    const listed = await state.runtime.substrate.listSessions();
    const recent = recordValue(
      await command('session.recent', { limit: 1000, include_ended: true }),
      'session.recent',
    );
    const rows = [live, resumable].map((opened) => {
      const row = recent.sessions?.find((session) => session.session_id === opened.session_id);
      if (!row) throw new Error(`status-accuracy missing ${opened.session_id} from recent`);
      const name = `substrate-${opened.session_id}`;
      return {
        session_id: opened.session_id,
        substrate_name: name,
        substrate_live: listed.some((session) => session.name === name && session.live),
        status: row.state,
        expected_state: opened.session_id === live.session_id ? 'live' : 'resumable',
      };
    });
    soak.assertStatusAccuracy(rows);
    log(`status-accuracy live=${rows[0].status} resumable=${rows[1].status}`);
    await closeSubstrateSession(live.session_id, live.stream_id, liveName);
    await closeSubstrateSession(resumable.session_id, resumable.stream_id, resumableName);
  });
  await runPhase('resume-delivery', async () => {
    if (!substrateReady) {
      log('phase resume-delivery SKIP abduco binary unavailable');
      return;
    }
    const provider = options.provider === 'fake' ? 'omp' : options.provider;
    const resumable = await openRecordedSession(provider, 'SOAK-RESUME-SEED');
    const substrateName = `substrate-${resumable.session_id}`;
    state.substrateNames.add(substrateName);
    const oldRuntime = state.runtime;
    await stopRuntime(oldRuntime);
    await oldRuntime.substrate.kill(substrateName);
    state.runtime = await startRuntime(false);
    state.sessionId = resumable.session_id;
    state.streamId = resumable.stream_id;
    state.stopped = false;
    const prompt = `SOAK-RESUME-DELIVERY-${state.cycle}`;
    const sent = recordValue(
      await command('session.send', { session_id: state.sessionId, prompt }),
      'session.send',
    );
    if (typeof sent.turn !== 'number') throw new Error('resume delivery send omitted turn');
    await waitForEvents((events) => {
      const input = events.find(
        (event) =>
          event?.type === 'session_input' &&
          event.payload?.text === prompt &&
          event.payload?.session_id === state.sessionId,
      );
      return (
        input !== undefined &&
        events.some(
          (event) =>
            event?.type === 'turn_complete' &&
            event.payload?.turn === sent.turn &&
            event.seq > input.seq,
        )
      );
    }, `resumed prompt delivery turn=${sent.turn}`);
    const events = await readEvents();
    const recent = recordValue(
      await command('session.recent', { limit: 1000, include_ended: true }),
      'session.recent',
    );
    const row = recent.sessions?.find((session) => session.session_id === state.sessionId);
    soak.assertResumeDelivery({
      prompt,
      session_id: state.sessionId,
      events,
      ...(typeof row?.pending_prompt === 'string' ? { pending_prompt: row.pending_prompt } : {}),
    });
    await closeSubstrateSession(state.sessionId, state.streamId, `substrate-${state.sessionId}`);
    log(`resume-delivery turn=${sent.turn}`);
  });
  await runPhase('clobber-guard', async () => {
    const ref = `external-${state.cycle}-${Date.now()}`;
    const machineDirectory = `${machineRoot}/omp`;
    const transcript = `${machineDirectory}/${ref}.jsonl`;
    fs.mkdirSync(machineDirectory, { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({ type: 'session', cwd: projectDir }) + '\n');
    const now = new Date();
    fs.utimesSync(transcript, now, now);
    let blocked = false;
    try {
      await command('session.resume', {
        source: 'omp',
        ref,
        prompt: 'SOAK-CLOBBER-GUARD',
        cwd: projectDir,
        origin: 'operator',
      });
    } catch (error) {
      blocked = String(error).includes('external session appears active');
    } finally {
      fs.rmSync(transcript, { force: true });
    }
    if (!blocked) throw new Error('external-active clobber guard allowed an active resume');
    log('clobber-guard rejected active external session');
    if (!substrateReady) {
      log('clobber-guard substrate duplicate check SKIP abduco binary unavailable');
      return;
    }
    const name = `substrate-clobber-${state.cycle}-${Date.now()}`;
    state.substrateNames.add(name);
    const argv = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
    await state.runtime.substrate.createSession(name, argv, { cwd: projectDir });
    let duplicateBlocked = false;
    try {
      await state.runtime.substrate.createSession(name, argv, { cwd: projectDir });
    } catch {
      duplicateBlocked = true;
    }
    await state.runtime.substrate.kill(name);
    state.substrateNames.delete(name);
    if (!duplicateBlocked) throw new Error('substrate duplicate creation was allowed');
    log('clobber-guard duplicate substrate creation was rejected');
  });
  await runPhase('reconcile-adopt', async () => {
    if (!substrateReady) {
      log('phase reconcile-adopt SKIP abduco binary unavailable');
      return;
    }
    const sessionId = `adopt-${state.cycle}-${Date.now()}`;
    const name = `substrate-${sessionId}`;
    state.substrateNames.add(name);
    await state.runtime.substrate.createSession(
      name,
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { cwd: projectDir },
    );
    const oldRuntime = state.runtime;
    await stopRuntime(oldRuntime);
    state.runtime = await startRuntime(false);
    const recent = recordValue(
      await command('session.recent', { limit: 1000, include_ended: true }),
      'session.recent',
    );
    const row = recent.sessions?.find((session) => session.session_id === sessionId);
    if (!row || row.state !== 'live')
      throw new Error(`reconcile-adopt did not expose ${sessionId} as live`);
    await closeSubstrateSession(sessionId, `session:${sessionId}`, name);
    log(`reconcile-adopt session=${sessionId}`);
  });
  await runPhase('reap/resume', async () => {
    if (options.provider === 'fake') {
      log('phase reap/resume SKIP provider=fake (idle substrate path covered by resume-delivery)');
      return;
    }
    await sleep(750);
    await state.runtime.sessions.reapIdle();
    await waitForEvents(
      (events) =>
        events.some(
          (event) =>
            event?.type === 'session_state' &&
            event.payload?.reason === 'reaped' &&
            event.payload?.state === 'resumable',
        ),
      'idle reaper state',
    );
    const substrateName = `substrate-${state.sessionId}`;
    const listed = await state.runtime.substrate.listSessions();
    if (listed.some((session) => session.name === substrateName && session.live))
      throw new Error('idle reaper left the substrate live');
    await sendTurn('SOAK-COLD-RESUME-HISTORY: reply with this marker only');
    await waitForEvents(
      (events) =>
        events.some(
          (event) =>
            event?.type === 'session_state' &&
            event.payload?.reason === 'resumed' &&
            event.payload?.state === 'live',
        ),
      'cold resume state',
    );
    await stopSession();
  });
  await runPhase('invariants', async () => {
    await stopSession();
    const live = await readEvents();
    const replayed = await readEvents();
    soak.assertReplayMatchesLive(live, replayed);
    const report = soak.assertEventInvariants(live, state.streamId);
    if (report.kinds.session_started !== 1 || report.kinds.session_complete !== 1)
      throw new Error('session start/complete invariant failed');
    if (report.kinds.verify_failed !== 0)
      throw new Error('verify_failed event entered the soak stream');
    const listed = recordValue(await command('session.list', { limit: 1000 }), 'session.list');
    soak.assertNoStuckSessions(listed.sessions ?? []);
    state.report = report;
    log(
      `invariants kinds=${JSON.stringify(report.kinds)} turns=${report.turnCount} replay=${report.replayCount}`,
    );
  });
}
