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
import { createTurnRelay } from './turn-relay.js';

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
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

type ReplyTarget = { chatId: number; threadId?: number };
type Project = { name: string; path: string };

const HELP_TEXT = [
  '/new <project> <prompt> — start a session in a new topic',
  '/sessions — list sessions attached to topics',
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
  const { relayTurn } = createTurnRelay({ api, bridge, config, format });
  const inFlight = new Set<number>();
  const pendingProjects = new Map<number, Project>();
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

  async function createSession(
    message: IncomingMessage,
    project: Project,
    prompt: string,
  ): Promise<void> {
    await ensureHealthy();
    const name = topicName(project.name, prompt);
    const topic = await api.createForumTopic({ chatId: message.chatId, name });
    const opened = await bridge.open({
      cwd: project.path,
      prompt,
      project: project.name,
    });
    store.bind({
      threadId: topic.threadId,
      sessionId: opened.sessionId,
      label: name,
      createdAt: new Date().toISOString(),
    });
    lastTurns.set(opened.sessionId, opened.turn);
    await api.sendMessage({
      chatId: message.chatId,
      threadId: topic.threadId,
      text: `session ${opened.sessionId} started in ${project.name}`,
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
    }
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
    await ensureHealthy();
    const [bindings, sessions] = await Promise.all([Promise.resolve(store.all()), bridge.list()]);
    const text = bindings.length
      ? bindings
          .map((binding) => {
            const status =
              sessions.find((session) => session.sessionId === binding.sessionId)?.status ??
              'unknown';
            return (
              `${binding.label} — ${status} ` + `(thread ${binding.threadId}, ${binding.sessionId})`
            );
          })
          .join('\n')
      : '(no sessions)';
    await reply(messageTarget(message), text);
  }

  async function handleCallback(callback: CallbackQuery): Promise<void> {
    await api.answerCallbackQuery(callback.id);
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
    pendingProjects.set(callback.message.chatId, project);
    await reply(callbackTarget(callback), `send the first prompt for ${project.name}`);
  }

  async function handleTopicCommand(
    message: IncomingMessage,
    binding: TopicBinding,
    command: string,
  ): Promise<boolean> {
    const target = messageTarget(message);
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
      await ensureHealthy();
      const stopped = await bridge.stop(binding.sessionId);
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

  async function runTurn(message: IncomingMessage, binding: TopicBinding): Promise<void> {
    const threadId = message.threadId;
    if (threadId === undefined) return;
    if (inFlight.has(threadId)) {
      await reply(messageTarget(message), 'still working on the previous turn');
      return;
    }

    inFlight.add(threadId);
    try {
      await ensureHealthy();
      const sent = await bridge.send({ sessionId: binding.sessionId, prompt: message.text ?? '' });
      lastTurns.set(binding.sessionId, sent.turn);
      await relayTurn({
        chatId: message.chatId,
        threadId,
        sessionId: binding.sessionId,
        turn: sent.turn,
      });
    } finally {
      inFlight.delete(threadId);
    }
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

  async function handleGeneralMessage(message: IncomingMessage): Promise<void> {
    const pending = pendingProjects.get(message.chatId);
    if (pending) {
      pendingProjects.delete(message.chatId);
      await createSession(message, pending, message.text?.trim() ?? '');
      return;
    }

    const command = commandName(message.text ?? '');
    if (command === 'new') {
      await handleNew(message);
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
