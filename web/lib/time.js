export function eventClock(timestamp) {
  const date = new Date(timestamp ?? '');
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relativeTime(timestamp) {
  const time = new Date(timestamp ?? '').getTime();
  if (!Number.isFinite(time)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
