// The raw command wire. /client.js is a generated SDK that only knows the commands it was built
// with, and it cannot carry an AbortSignal — so the two places that need either (a command the
// bundled SDK predates, and a transcription the owner can cancel mid-upload) post here instead.
// Same contract the SDK uses: POST /commands/<name> with a JSON body, `{ value }` on success.
export async function postCommand(name, args, { baseUrl, token, signal } = {}) {
  if (typeof globalThis.fetch !== 'function') throw new Error('global fetch is unavailable');
  const base = String(baseUrl ?? globalThis.location.origin).replace(/\/+$/, '');
  const response = await globalThis.fetch(`${base}/commands/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(args ?? {}),
    ...(signal ? { signal } : {}),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`control plane returned HTTP ${response.status}`);
  }
  if (!response.ok) {
    const reason = body && typeof body === 'object' ? body.error : undefined;
    throw new Error(
      typeof reason === 'string' ? reason : `${name} returned HTTP ${response.status}`,
    );
  }
  if (!body || typeof body !== 'object' || !('value' in body))
    throw new Error('control plane returned an invalid response');
  return body.value;
}

// An aborted fetch rejects with a DOMException, not an Error the caller should surface.
export function isAbortError(error) {
  return Boolean(error) && error.name === 'AbortError';
}

// Normalize any thrown value to a display string.
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
