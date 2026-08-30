import type { IncomingMessage } from 'node:http';

export function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let serialized = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      serialized += chunk;
    });
    request.on('end', () => {
      if (!serialized.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(serialized) as unknown);
      } catch (error: unknown) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
