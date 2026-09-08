import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createTelegramApi } from './api.js';
import { createSessionBridge } from './bridge.js';
import { getTelegramApiBase, getTelegramProvider, loadTelegramConfig } from './config.js';
import { escapeMarkdownV2, chunkText } from './format.js';
import { createTelegramBot, type TelegramBot } from './bot.js';
import { openTopicStore } from './store.js';
import type { TelegramApi, TopicStore } from './types.js';

export interface TelegramBotLoopOptions {
  api: Pick<TelegramApi, 'getUpdates'>;
  bot: Pick<TelegramBot, 'handleUpdate'>;
  store: Pick<TopicStore, 'getOffset' | 'setOffset'>;
  pollTimeoutSec: number;
  signal: AbortSignal;
  retryBackoffMs?: number;
}

export async function runTelegramBot(options: TelegramBotLoopOptions): Promise<void> {
  const retryBackoffMs = Math.max(1, options.retryBackoffMs ?? 250);
  let offset = options.store.getOffset();

  while (!options.signal.aborted) {
    let updates;
    try {
      updates = await options.api.getUpdates(offset, options.pollTimeoutSec, options.signal);
    } catch (error: unknown) {
      if (options.signal.aborted) break;
      console.error(`[telegram] Telegram getUpdates failed: ${formatError(error)}`);
      if (!(await waitForRetry(retryBackoffMs, options.signal))) break;
      continue;
    }

    for (const update of updates) {
      if (options.signal.aborted) break;
      try {
        await options.bot.handleUpdate(update);
      } catch (error: unknown) {
        console.error(
          `[telegram] Telegram update ${update.updateId} failed: ${formatError(error)}`,
        );
      }
      offset = update.updateId + 1;
      options.store.setOffset(offset);
      process.stdout.write(`[telegram] handled Telegram update ${update.updateId}\n`);
    }
  }
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolvePromise(result);
    };
    const abort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function main(): Promise<void> {
  let config;
  try {
    config = loadTelegramConfig();
  } catch (error: unknown) {
    console.error(`[telegram] ${formatError(error)}`);
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  let store: TopicStore | undefined;
  let bot: TelegramBot | undefined;
  const stop = (): void => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    const api = createTelegramApi(config, undefined, getTelegramApiBase());
    const bridge = createSessionBridge(config, getTelegramProvider());
    store = openTopicStore(config.dbPath);
    bot = createTelegramBot({
      api,
      bridge,
      store,
      config,
      format: { escapeMarkdownV2, chunkText },
    });
    bot.start();
    const me = await api.getMe();
    process.stdout.write(`[telegram] Telegram bot @${me.username} started\n`);
    await runTelegramBot({
      api,
      bot,
      store,
      pollTimeoutSec: config.pollTimeoutSec,
      signal: controller.signal,
    });
    process.exitCode = 0;
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      console.error(`[telegram] Telegram bot failed: ${formatError(error)}`);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    bot?.stop();
    store?.close();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main();
}
