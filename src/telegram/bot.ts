import type {
  CallbackQuery,
  IncomingMessage,
  SessionBridge,
  TelegramApi,
  TelegramConfig,
  TelegramUpdate,
  TopicBinding,
  TopicStore,
} from './types.js';
import { createResumeHandler, truncateTitle, type PendingStart } from './resume.js';
import { handleRenameCommand, RENAME_GENERAL_REPLY } from './rename.js';
import { createTurnRelay } from './turn-relay.js';
import { createEcho } from './echo.js';
import { createSessionWatch } from './session-watch.js';

export interface TelegramFormat {
  escapeMarkdownV2(text: string): string;
  chunkText(text: string, max?: number): string[];
}

export interface TelegramBotDependencies {
  api: TelegramApi;
  bridge: SessionBridge;
  store: TopicStore;
  config: TelegramConfig;
  format: TelegramFormat;
}

export interface TelegramBot {
  start(): void;
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

type ReplyTarget = { chatId: number; threadId?: number };
type Project = { name: string; path: string };
type OpenedSession = { sessionId: string; turn: number };
type OpenSession = () => Promise<OpenedSession>;

const HELP_TEXT = [
  '/new <project> <prompt> — start a session in a new topic',
  '/resume — bind a live session or continue a machine session in a new topic',
  '/rename <name> — rename this session topic',
  '/sessions — list live sessions with topic bindings',
  '/status — show this session state and last turn',
  '/stop — stop this session',
  '/attach — print the terminal attach command',
  '/help — show this help',
].join('\n');

function messageTarget(message: IncomingMessage): ReplyTarget {
  if (message.threadId === undefined) return { chatId: message.chatId };
  return { chatId: message.chatId, threadId: message.threadId };
}

function callbackTarget(callback: CallbackQuery): ReplyTarget {
  if (callback.message.threadId === undefined) return { chatId: callback.message.chatId };
  return { chatId: callback.message.chatId, threadId: callback.message.threadId };
}

function commandName(text: string): string | null {
  const first = text.trim().split(/\s+/, 1)[0];
  if (!first?.startsWith('/')) return null;
  return first.slice(1).split('@', 1)[0]?.toLowerCase() || null;
}

function commandArguments(text: string): string {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? '' : trimmed.slice(firstSpace).trim();
}

function promptHead(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() || 'new session';
  return firstLine.length <= 64 ? firstLine : `${firstLine.slice(0, 63)}…`;
}

function topicName(project: string, prompt: string): string {
  return `${project} · ${promptHead(prompt)}`;
}

export function createTelegramBot(deps: TelegramBotDependencies): TelegramBot {
  const { api, bridge, store, config, format } = deps;
  const echo = createEcho({ api, store, format, chatId: config.chatId });
  const sessionWatch = createSessionWatch({ bridge, store, echoTurn: echo.echoTurn });
  const { relayTurn } = createTurnRelay({ api, bridge, config, format });
  const inFlight = new Set<number>();
  const pendingStarts = new Map<number, PendingStart>();
  const projectChoices = new Map<string, Project>();
  const lastTurns = new Map<string, number>();

  async function ensureHealthy(): Promise<void> {
    if (!(await bridge.health())) throw new Error('health check failed');
  }

  async function reply(target: ReplyTarget, text: string): Promise<void> {
    await api.sendMessage({ ...target, text });
  }

  async function replyError(target: ReplyTarget, error: unknown): Promise<void> {
    try {
      const reason = error instanceof Error ? error.message : String(error);
      await reply(target, `control plane unresponsive: ${reason}`);
    } catch {
      // The poll loop must survive even when the error reply cannot be sent.
    }
  }
  const resumeHandler = createResumeHandler({
    api,
    bridge,
    store,
    ensureHealthy,
    pendingStarts,
    reply,
    onBind: sessionWatch.watch,
  });

  async function chooseProject(message: IncomingMessage): Promise<void> {
    await ensureHealthy();
    const projects = await bridge.projects();
    projectChoices.clear();
    for (const project of projects) projectChoices.set(project.name, project);
    await api.sendMessage({
      chatId: message.chatId,
      text: 'Choose a project, then send the first prompt here:',
      buttons: projects.map((project) => [
        { text: project.name, callbackData: `new:${encodeURIComponent(project.name)}` },
      ]),
    });
  }
  async function startSessionInTopic(
    message: IncomingMessage,
    name: string,
    prompt: string,
    open: OpenSession,
    notice: (sessionId: string) => string,
    onOpenError?: (error: unknown) => Promise<void>,
  ): Promise<void> {
    const topic = await api.createForumTopic({ chatId: message.chatId, name });
    let opened: OpenedSession;
    try {
      opened = await open();
    } catch (error: unknown) {
      if (onOpenError === undefined) throw error;
      await onOpenError(error);
      return;
    }
    store.bind({
      threadId: topic.threadId,
      sessionId: opened.sessionId,
      label: name,
      createdAt: new Date().toISOString(),
    });
    sessionWatch.markSent(opened.sessionId, prompt);
    sessionWatch.markRelayed(opened.sessionId, opened.turn);
    lastTurns.set(opened.sessionId, opened.turn);
    await api.sendMessage({
      chatId: message.chatId,
      threadId: topic.threadId,
      text: notice(opened.sessionId),
    });
    inFlight.add(topic.threadId);
    try {
      await relayTurn({
        chatId: message.chatId,
        threadId: topic.threadId,
        sessionId: opened.sessionId,
        turn: opened.turn,
      });
    } finally {
      inFlight.delete(topic.threadId);
      sessionWatch.watch(opened.sessionId);
    }
  }

  async function createSession(
    message: IncomingMessage,
    project: Project,
    prompt: string,
  ): Promise<void> {
    await ensureHealthy();
    const name = topicName(project.name, prompt);
    await startSessionInTopic(
      message,
      name,
      prompt,
      () =>
        bridge.open({
          cwd: project.path,
          prompt,
          project: project.name,
        }),
      (sessionId) => `session ${sessionId} started in ${project.name}`,
    );
  }

  async function resumeSession(
    message: IncomingMessage,
    pending: Extract<PendingStart, { kind: 'resume' }>,
    prompt: string,
  ): Promise<void> {
    await ensureHealthy();
    const name = truncateTitle(pending.title, 60);
    await startSessionInTopic(
      message,
      name,
      prompt,
      () =>
        bridge.resume({
          source: pending.source,
          ref: pending.ref,
          prompt,
          cwd: pending.cwd,
        }),
      (sessionId) => `session ${sessionId} resumed from ${pending.source}`,
      async (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        await reply(messageTarget(message), `resume failed: ${reason}`);
      },
    );
  }

  async function resolveProject(name: string): Promise<Project | null> {
    const cached = projectChoices.get(name);
    if (cached) return cached;
    await ensureHealthy();
    const project = (await bridge.projects()).find((candidate) => candidate.name === name);
    if (project) projectChoices.set(project.name, project);
    return project ?? null;
  }

  async function handleNew(message: IncomingMessage): Promise<void> {
    const args = commandArguments(message.text ?? '');
    if (!args) {
      await chooseProject(message);
      return;
    }

    const separator = args.search(/\s/);
    const projectName = separator < 0 ? args : args.slice(0, separator);
    const prompt = separator < 0 ? '' : args.slice(separator).trim();
    if (!prompt) {
      await reply(messageTarget(message), 'usage: /new <project> <prompt>');
      return;
    }

    const project = await resolveProject(projectName);
    if (!project) {
      await reply(messageTarget(message), `unknown project: ${projectName}`);
      return;
    }
    await createSession(message, project, prompt);
  }

  async function handleSessions(message: IncomingMessage): Promise<void> {
    await resumeHandler.handleSessions(message);
  }

  async function handleCallback(callback: CallbackQuery): Promise<void> {
    await api.answerCallbackQuery(callback.id);
    if (await resumeHandler.handleCallback(callback)) return;
    if (!callback.data.startsWith('new:')) return;
    const encodedName = callback.data.slice(4);
    let projectName: string;
    try {
      projectName = decodeURIComponent(encodedName);
    } catch {
      await reply(callbackTarget(callback), 'that project selection is invalid');
      return;
    }

    const project = await resolveProject(projectName);
    if (!project) {
      await reply(callbackTarget(callback), `unknown project: ${projectName}`);
      return;
    }
    pendingStarts.set(callback.message.chatId, { kind: 'new', project });
    await reply(callbackTarget(callback), `send the first prompt for ${project.name}`);
  }

  async function handleTopicCommand(
    message: IncomingMessage,
    binding: TopicBinding,
    command: string,
  ): Promise<boolean> {
    const target = messageTarget(message);
    if (command === 'rename') {
      await handleRenameCommand(
        { api, bridge, store },
        {
          chatId: message.chatId,
          threadId: binding.threadId,
          sessionId: binding.sessionId,
          argumentText: commandArguments(message.text ?? ''),
        },
      );
      return true;
    }
    if (command === 'status') {
      await ensureHealthy();
      const sessions = await bridge.list();
      const turn = lastTurns.get(binding.sessionId) ?? 0;
      const status =
        sessions.find((session) => session.sessionId === binding.sessionId)?.status ?? 'unknown';
      await reply(target, `${status}; last turn ${turn}`);
      return true;
    }
    if (command === 'stop') {
      const stopped = await bridge.stop(binding.sessionId);
      sessionWatch.unwatch(binding.sessionId);
      await reply(
        target,
        stopped ? `stopped ${binding.sessionId}` : `already stopped ${binding.sessionId}`,
      );
      return true;
    }
    if (command === 'attach') {
      await reply(target, `vibecodium attach ${binding.sessionId}`);
      return true;
    }
    if (command === 'help') {
      await reply(target, HELP_TEXT);
      return true;
    }
    return false;
  }

  async function handleTopicMessage(
    message: IncomingMessage,
    binding: TopicBinding,
  ): Promise<void> {
    const threadId = message.threadId;
    if (threadId !== undefined && inFlight.has(threadId)) {
      await reply(messageTarget(message), 'still working on the previous turn');
      return;
    }
    const command = commandName(message.text ?? '');
    if (command && (await handleTopicCommand(message, binding, command))) return;
    if (command) {
      await reply(messageTarget(message), 'unknown command; use /help');
      return;
    }
    await runTurn(message, binding);
  }

  async function runTurn(message: IncomingMessage, binding: TopicBinding): Promise<void> {
    const threadId = message.threadId;
    if (threadId === undefined) return;
    if (inFlight.has(threadId)) {
      await reply(messageTarget(message), 'still working on the previous turn');
      return;
    }

    inFlight.add(threadId);
    sessionWatch.unwatch(binding.sessionId);
    try {
      await ensureHealthy();
      if ((await bridge.openTurn(binding.sessionId)) !== null) {
        await reply(messageTarget(message), 'still working on the previous turn');
        return;
      }
      const prompt = message.text ?? '';
      sessionWatch.markSent(binding.sessionId, prompt);
      const sent = await bridge.send({ sessionId: binding.sessionId, prompt });
      sessionWatch.markRelayed(binding.sessionId, sent.turn);
      lastTurns.set(binding.sessionId, sent.turn);
      await relayTurn({
        chatId: message.chatId,
        threadId,
        sessionId: binding.sessionId,
        turn: sent.turn,
      });
    } finally {
      inFlight.delete(threadId);
      sessionWatch.watch(binding.sessionId);
    }
  }

  async function handleGeneralMessage(message: IncomingMessage): Promise<void> {
    const pending = pendingStarts.get(message.chatId);
    if (pending) {
      pendingStarts.delete(message.chatId);
      const prompt = message.text?.trim() ?? '';
      if (pending.kind === 'new') {
        await createSession(message, pending.project, prompt);
      } else {
        await resumeSession(message, pending, prompt);
      }
      return;
    }

    const command = commandName(message.text ?? '');
    if (command === 'new') {
      await handleNew(message);
      return;
    }
    if (command === 'resume') {
      await resumeHandler.handleCommand(message);
      return;
    }
    if (command === 'rename') {
      await reply(messageTarget(message), RENAME_GENERAL_REPLY);
      return;
    }
    if (command === 'sessions') {
      await handleSessions(message);
      return;
    }
    if (command === 'help') {
      await reply(messageTarget(message), HELP_TEXT);
      return;
    }
    if (command) {
      await reply(messageTarget(message), 'use /help for commands');
    }
  }

  async function handleMessage(message: IncomingMessage): Promise<void> {
    if (message.isTopicMessage && message.threadId !== undefined) {
      const binding = store.byThread(message.threadId);
      if (binding) {
        await handleTopicMessage(message, binding);
      }
      return;
    }
    await handleGeneralMessage(message);
  }

  return {
    start(): void {
      sessionWatch.start();
    },
    async handleUpdate(update: TelegramUpdate): Promise<void> {
      const fromId = update.callbackQuery?.from.id ?? update.message?.from.id;
      if (fromId !== config.allowedUserId) return;

      const target = update.callbackQuery
        ? callbackTarget(update.callbackQuery)
        : update.message
          ? messageTarget(update.message)
          : null;
      if (!target) return;

      try {
        if (update.callbackQuery) {
          await handleCallback(update.callbackQuery);
        } else if (update.message) {
          await handleMessage(update.message);
        }
      } catch (error) {
        await replyError(target, error);
      }
    },
  };
}
