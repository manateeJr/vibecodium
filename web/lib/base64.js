// Base64 bridges the JSON command protocol and the browser's binary types.
const CHUNK = 0x8000;

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  return globalThis.btoa(binary);
}

export async function blobToBase64(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

// Byte-exact: atob yields one code unit per byte, so UTF-8 sequences and ANSI escapes survive.
export function base64ToBytes(base64) {
  const binary = globalThis.atob(String(base64 ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64ToBlob(base64, mime) {
  const type = String(mime ?? '').trim() || 'application/octet-stream';
  return new globalThis.Blob([base64ToBytes(base64)], { type });
}
