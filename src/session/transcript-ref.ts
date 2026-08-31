import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Extract the harness session ref from an OMP transcript filename.
 *
 * OMP names transcripts `<timestamp>_<harness-ref>.jsonl`; the timestamp is
 * the portion before the first underscore, while the ref may itself contain
 * underscores. Paths that are not in that format return undefined.
 */
export function harnessRefFromTranscriptPath(transcriptPath: string): string | undefined {
  const filename = path.basename(transcriptPath);
  const match = /^[^_]+_(.+)\.jsonl$/.exec(filename);
  return match?.[1];
}

export async function discoverTranscript(
  storageDir: string,
  fallback: string,
  preferred: string,
): Promise<string> {
  try {
    const entries = await readdir(storageDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(storageDir, entry.name))
      .sort();
    if (files.length === 0) return fallback;
    if (files.includes(preferred)) return preferred;
    return files[files.length - 1] ?? fallback;
  } catch {
    return fallback;
  }
}
