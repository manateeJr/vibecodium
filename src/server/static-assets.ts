import fs from 'node:fs';
import path from 'node:path';

export interface StaticAssetResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const NOT_FOUND: StaticAssetResponse = {
  status: 404,
  contentType: 'text/plain',
  body: Buffer.from('not_found'),
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/manifest+json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function serveStaticAsset(webDir: string, requestPath: string): StaticAssetResponse {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return NOT_FOUND;
  }
  const normalizedPath = decodedPath.replaceAll('\\', '/');
  if (
    !normalizedPath.startsWith('/') ||
    normalizedPath.includes('\0') ||
    normalizedPath.split('/').some((segment) => segment === '..')
  ) {
    return NOT_FOUND;
  }
  const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.slice(1);
  if (!relativePath || relativePath.startsWith('/')) return NOT_FOUND;

  const root = path.resolve(webDir);
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return NOT_FOUND;
  try {
    const realRoot = fs.realpathSync(root);
    const realFilePath = fs.realpathSync(filePath);
    if (
      (realFilePath !== realRoot && !realFilePath.startsWith(`${realRoot}${path.sep}`)) ||
      !fs.statSync(realFilePath).isFile()
    )
      return NOT_FOUND;
    return {
      status: 200,
      contentType:
        CONTENT_TYPES[path.extname(realFilePath).toLowerCase()] ?? 'application/octet-stream',
      body: fs.readFileSync(realFilePath),
    };
  } catch {
    return NOT_FOUND;
  }
}
