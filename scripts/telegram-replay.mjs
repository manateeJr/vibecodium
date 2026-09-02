#!/usr/bin/env node
import {
  CHAT_ID,
  callbackQueryUpdate,
  messageUpdate,
  startTelegramStub,
  THREAD_ID,
  USER_ID,
} from '../dist/test/helpers/telegram-stub.js';
import { parseReplayArgs } from './telegram-replay/args.mjs';
import { runReplay } from './telegram-replay/replay.mjs';

try {
  const options = parseReplayArgs(process.argv.slice(2));
  await runReplay({
    ...options,
    telegram: {
      CHAT_ID,
      THREAD_ID,
      USER_ID,
      callbackQueryUpdate,
      messageUpdate,
      startTelegramStub,
    },
  });
} catch (error) {
  globalThis.console.error(
    `[replay] FAIL ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
