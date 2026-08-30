// Shared path arithmetic: the browser maps cwds onto registered projects the same way everywhere.
export function normalizePath(value) {
  const raw = String(value ?? '').trim();
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || (raw.startsWith('/') ? '/' : '');
}

export function pathMatches(cwd, projectPath) {
  const root = normalizePath(projectPath);
  const path = normalizePath(cwd);
  if (!path || !root) return false;
  return root === '/' ? path.startsWith('/') : path === root || path.startsWith(`${root}/`);
}

// The deepest registered project wins, so nested checkouts do not steal each other's sessions.
export function projectForPath(cwd, projects) {
  const path = normalizePath(cwd);
  if (!path) return '';
  const match = projects
    .filter((project) => pathMatches(path, project.path))
    .sort((left, right) => normalizePath(right.path).length - normalizePath(left.path).length)[0];
  return match?.name ?? '';
}

export function basename(value) {
  const normalized = normalizePath(value);
  if (normalized === '/' || !normalized) return normalized;
  return normalized.split('/').pop() || normalized;
}
