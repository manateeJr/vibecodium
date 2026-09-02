import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Readable } from 'node:stream';
import { ControlPlane } from '../src/server/control-plane.js';
import {
  callBody,
  CHAT_ID,
  messageUpdate,
  startTelegramStub,
  THREAD_ID,
  USER_ID,
} from './helpers/telegram-stub.js';

type JsonRecord = Record<string, unknown>;

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

type TelegramChild = ChildProcessByStdio<null, Readable, Readable>;

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    // Network/process integration cannot be driven by fake timers; poll with a bounded interval.
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function waitForAsyncCondition(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    // Network/process integration cannot be driven by fake timers; poll with a bounded interval.
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function waitForChild(child: TelegramChild): Promise<ChildExit> {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: null });
  return new Promise<ChildExit>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

async function waitForChildExit(exit: Promise<ChildExit>, timeoutMs = 8_000): Promise<ChildExit> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ChildExit>((_, reject) => {
    // A real process needs a wall-clock escape hatch; the handle is cleared after exit.
    timer = setTimeout(() => reject(new Error('Telegram child did not exit')), timeoutMs);
  });
  try {
    return await Promise.race([exit, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(
  child: TelegramChild,
  exit: Promise<ChildExit>,
  stderr: () => string,
): Promise<void> {
  if (child.exitCode === null) child.kill('SIGTERM');
  const result = await waitForChildExit(exit);
  assert.equal(result.code, 0, stderr());
  assert.equal(result.signal, null);
}

async function listSessions(httpUrl: string): Promise<readonly JsonRecord[]> {
  const response = await fetch(`${httpUrl}/commands/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { value: { sessions: readonly JsonRecord[] } };
  return body.value.sessions;
}

test('Telegram main drives a real fake-provider control-plane session end to end', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibecodium-telegram-e2e-'));
  const controlPlanePath = path.join(root, 'control-plane.sqlite');
  const projectsPath = path.join(root, 'projects.json');
  const telegramDbPath = path.join(root, 'telegram.sqlite');
  const projectPath = path.join(root, 'project');
  mkdirSync(projectPath);
  writeFileSync(
    projectsPath,
    JSON.stringify({
      projects: [
        {
          name: 'demo',
          path: projectPath,
          description: 'Telegram e2e project',
          quickActions: [],
          scope: 'project',
        },
      ],
    }),
  );

  const initialUpdates = [messageUpdate(1, 10, '/new demo hello', false)];
  const stub = await startTelegramStub(initialUpdates);
  let plane: ControlPlane | undefined;
  let planeStopped = false;
  let child: TelegramChild | undefined;
  let childExit: Promise<ChildExit> | undefined;
  let stdout = '';
  let stderr = '';
  const environmentNames = ['VIBECODIUM_DB_PATH', 'VIBECODIUM_PROJECTS_PATH'];
  const previousEnvironment = new Map<string, string | undefined>();
  for (const name of environmentNames) previousEnvironment.set(name, process.env[name]);

  try {
    process.env.VIBECODIUM_DB_PATH = controlPlanePath;
    process.env.VIBECODIUM_PROJECTS_PATH = projectsPath;
    plane = new ControlPlane({ dataPath: controlPlanePath, port: 0 });
    const address = await plane.start();
    const entrypoint = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/telegram/main.js',
    );
    const runningChild = spawn(process.execPath, [entrypoint], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      env: {
        ...process.env,
        VIBECODIUM_DB_PATH: controlPlanePath,
        VIBECODIUM_PROJECTS_PATH: projectsPath,
        VIBECODIUM_TELEGRAM_TOKEN: 'test-token',
        VIBECODIUM_TELEGRAM_USER_ID: String(USER_ID),
        VIBECODIUM_TELEGRAM_CHAT_ID: String(CHAT_ID),
        VIBECODIUM_URL: address.httpUrl,
        VIBECODIUM_TELEGRAM_DB_PATH: telegramDbPath,
        VIBECODIUM_TELEGRAM_API_BASE: `http://127.0.0.1:${stub.port}`,
        VIBECODIUM_TELEGRAM_PROVIDER: 'fake',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = runningChild;
    runningChild.stdout.setEncoding('utf8');
    runningChild.stderr.setEncoding('utf8');
    runningChild.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    runningChild.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    childExit = waitForChild(runningChild);

    await waitForCondition(
      () => stdout.includes('Telegram bot @e2e_bot started'),
      'Telegram startup',
    );
    await waitForCondition(
      () => stub.calls.some((call) => call.endpoint === 'createForumTopic'),
      'createForumTopic',
    );
    const createCall = stub.calls.find((call) => call.endpoint === 'createForumTopic');
    assert.ok(createCall);
    assert.equal(callBody(createCall).chat_id, CHAT_ID);
    assert.equal(callBody(createCall).name, 'demo · hello');

    let openedSession: JsonRecord | undefined;
    await waitForAsyncCondition(async () => {
      const sessions = await listSessions(address.httpUrl);
      openedSession = sessions.find(
        (session) => session.project === 'demo' && session.provider === 'fake',
      );
      return openedSession !== undefined;
    }, 'fake session opened on control plane');
    assert.ok(openedSession);
    const sessionId = openedSession.session_id;
    assert.equal(typeof sessionId, 'string');
    await waitForCondition(
      () =>
        plane?.eventStore
          .read(`session:${sessionId}`, 0)
          .some((event) => event.type === 'turn_complete') ?? false,
      'initial fake-provider turn',
    );
    await waitForCondition(
      () =>
        stub.calls.some(
          (call) =>
            call.endpoint === 'editMessageText' &&
            String(callBody(call).text ?? '').includes('echo:hello'),
        ),
      'initial fake-provider edit',
    );
    const initialFinalEdit = stub.calls.find(
      (call) =>
        call.endpoint === 'editMessageText' &&
        String(callBody(call).text ?? '').includes('echo:hello'),
    );
    assert.ok(initialFinalEdit);
    assert.equal(callBody(initialFinalEdit).chat_id, CHAT_ID);
    const initialWorkingCall = stub.calls.find(
      (call) =>
        call.endpoint === 'sendMessage' &&
        String(callBody(call).text ?? '').startsWith('working…') &&
        callBody(call).message_thread_id === THREAD_ID,
    );
    assert.ok(initialWorkingCall);
    assert.equal(initialWorkingCall.messageId !== undefined, true);
    assert.equal(callBody(initialWorkingCall).message_thread_id, THREAD_ID);
    assert.equal(callBody(initialFinalEdit).message_id, initialWorkingCall.messageId);
    const callsBefore = stub.calls.length;
    stub.enqueue(messageUpdate(2, 11, 'telegram', true));

    await waitForCondition(
      () =>
        stub.calls
          .slice(callsBefore)
          .some(
            (call) =>
              call.endpoint === 'sendMessage' &&
              String(callBody(call).text ?? '').startsWith('working…'),
          ),
      'working progress sendMessage',
    );
    const workingCall = stub.calls
      .slice(callsBefore)
      .find(
        (call) =>
          call.endpoint === 'sendMessage' &&
          String(callBody(call).text ?? '').startsWith('working…'),
      );
    assert.ok(workingCall);
    assert.equal(callBody(workingCall).message_thread_id, THREAD_ID);
    assert.equal(workingCall.messageId !== undefined, true);

    await waitForCondition(
      () =>
        stub.calls
          .slice(callsBefore)
          .some(
            (call) =>
              call.endpoint === 'editMessageText' &&
              String(callBody(call).text ?? '').includes('echo:telegram'),
          ),
      'final fake-provider edit',
    );
    const edits = stub.calls
      .slice(callsBefore)
      .filter((call) => call.endpoint === 'editMessageText');
    assert.ok(edits.length >= 1);
    const finalEdit = stub.calls
      .slice(callsBefore)
      .find((call) => String(callBody(call).text ?? '').includes('echo:telegram'));
    assert.ok(finalEdit);
    assert.match(String(callBody(finalEdit).text), /echo:telegram/);
    assert.equal(callBody(finalEdit).message_id, workingCall.messageId);
    stub.enqueue(messageUpdate(3, 12, '/stop', true));

    await waitForCondition(
      () =>
        stub.calls.some(
          (call) =>
            call.endpoint === 'sendMessage' && callBody(call).text === `stopped ${sessionId}`,
        ),
      'stop confirmation',
    );
    await waitForAsyncCondition(
      async () =>
        (await listSessions(address.httpUrl)).some(
          (session) => session.session_id === sessionId && session.status === 'done',
        ),
      'stopped session state on control plane',
    );

    await plane.stop();
    planeStopped = true;
    stub.enqueue(messageUpdate(4, 13, 'after shutdown', true));
    await waitForCondition(
      () =>
        stub.calls.some(
          (call) =>
            call.endpoint === 'sendMessage' &&
            String(callBody(call).text ?? '').includes('control plane unresponsive'),
        ),
      'control-plane-unresponsive reply',
    );
    const unavailableReply = stub.calls.find(
      (call) =>
        call.endpoint === 'sendMessage' &&
        String(callBody(call).text ?? '').includes('control plane unresponsive'),
    );
    assert.ok(unavailableReply);
    assert.match(String(callBody(unavailableReply).text), /control plane unresponsive/);
    const exit = childExit;
    assert.ok(exit);
    await stopChild(runningChild, exit, () => stderr);
  } finally {
    if (child !== undefined && child.exitCode === null && childExit !== undefined) {
      child.kill('SIGTERM');
      try {
        await waitForChildExit(childExit);
      } catch {
        if (child.exitCode === null) child.kill('SIGKILL');
        try {
          await waitForChildExit(childExit);
        } catch {
          // SIGKILL is the final orphan-process guard.
        }
      }
    }
    await stub.close();
    if (plane !== undefined && !planeStopped) await plane.stop();
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
