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
export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return true;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
