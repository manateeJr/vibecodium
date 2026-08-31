// One byte formatter for the whole shell. The file browser sizes its rows with it and the reports
// inbox sizes its attachments with it, so it lives here rather than inside either panel.
export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  const mib = kib / 1024;
  return mib < 1024 ? `${mib.toFixed(1)} MB` : `${(mib / 1024).toFixed(1)} GB`;
}
