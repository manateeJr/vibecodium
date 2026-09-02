import type { TelegramConfig } from './types.js';

export const TELEGRAM_API_BASE_ENV = 'VIBECODIUM_TELEGRAM_API_BASE';
const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:4310';
const DEFAULT_DB_PATH = '.vibecodium/telegram.sqlite';
const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_TELEGRAM_PROVIDER = 'omp';

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function getTelegramApiBase(environment: NodeJS.ProcessEnv = process.env): string {
  return environment[TELEGRAM_API_BASE_ENV]?.trim() || DEFAULT_TELEGRAM_API_BASE;
}

export function getTelegramProvider(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.VIBECODIUM_TELEGRAM_PROVIDER?.trim() || DEFAULT_TELEGRAM_PROVIDER;
}

export function loadTelegramConfig(environment: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const invalid: string[] = [];
  const token = environment.VIBECODIUM_TELEGRAM_TOKEN?.trim();
  if (!token) invalid.push('VIBECODIUM_TELEGRAM_TOKEN');

  const allowedUserId = parseInteger(environment.VIBECODIUM_TELEGRAM_USER_ID);
  if (allowedUserId === undefined) invalid.push('VIBECODIUM_TELEGRAM_USER_ID');

  const chatId = parseInteger(environment.VIBECODIUM_TELEGRAM_CHAT_ID);
  if (chatId === undefined) invalid.push('VIBECODIUM_TELEGRAM_CHAT_ID');

  if (
    invalid.length > 0 ||
    token === undefined ||
    allowedUserId === undefined ||
    chatId === undefined
  ) {
    throw new Error(`Missing or invalid Telegram configuration: ${invalid.join(', ')}`);
  }

  return {
    token,
    allowedUserId,
    chatId,
    controlPlaneUrl: environment.VIBECODIUM_URL?.trim() || DEFAULT_CONTROL_PLANE_URL,
    dbPath: environment.VIBECODIUM_TELEGRAM_DB_PATH?.trim() || DEFAULT_DB_PATH,
    pollTimeoutSec: 50,
    progressThrottleMs: 5_000,
    turnTimeoutMs: 30 * 60 * 1_000,
  };
}
