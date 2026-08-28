import type {
  NotificationDelivery,
  NotificationMessage,
  NtfyNotifierOptions,
  Notifier,
} from './types.js';

export class NtfyNotifier implements Notifier {
  public readonly name = 'ntfy';
  private readonly baseUrl: string;
  private readonly topic: string;
  private readonly token: string | undefined;
  private readonly fetcher: typeof globalThis.fetch;

  public constructor(options: NtfyNotifierOptions = {}) {
    const configuredBaseUrl =
      options.baseUrl ?? process.env.VIBECODIUM_NTFY_BASE_URL ?? 'http://127.0.0.1:8080';
    const parsedBaseUrl = new URL(configuredBaseUrl);
    this.baseUrl = parsedBaseUrl.toString().replace(/\/$/, '');
    this.topic = options.topic ?? process.env.VIBECODIUM_NTFY_TOPIC ?? 'vibecodium';
    if (!this.topic || /[\r\n]/.test(this.topic)) throw new Error('ntfy topic is required');
    this.token = options.token ?? process.env.VIBECODIUM_NTFY_TOKEN;
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== 'function') throw new Error('global fetch is unavailable');
  }

  public async send(message: NotificationMessage): Promise<NotificationDelivery> {
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: message.title,
      Priority: priorityFor(message.severity),
      Tags: tagsFor(message),
    };
    if (message.actions.length > 0) headers.Actions = actionsHeader(message);
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetcher(`${this.baseUrl}/${encodeURIComponent(this.topic)}`, {
      method: 'POST',
      headers,
      body: message.body,
    });
    if (!response.ok) {
      throw new Error(`ntfy request failed with HTTP ${response.status}`);
    }
    return { channel: this.name, status: 'delivered' };
  }
}

function priorityFor(severity: NotificationMessage['severity']): string {
  if (severity === 'action') return 'urgent';
  if (severity === 'warn') return 'high';
  return 'default';
}

function tagsFor(message: NotificationMessage): string {
  if (message.severity === 'action') return 'rotating_light';
  if (message.severity === 'warn') return 'warning';
  return 'information_source';
}

function actionsHeader(message: NotificationMessage): string {
  return message.actions
    .map((action) => {
      const method = action.method ?? 'POST';
      const clear = action.clear === false ? 'clear=false' : 'clear=true';
      return `http, ${cleanHeaderValue(action.label)}, ${cleanHeaderValue(action.url)}, method=${method}, ${clear}`;
    })
    .join('; ');
}

function cleanHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim();
}
