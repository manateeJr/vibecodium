import { eventClock } from '../lib/time.js';
import { applySessionEvent } from './events.js';

// The one door control-plane events come through, live or replayed. Dedupe lives here because a
// reconnect replays from the last seen sequence and a manual hydrate replays from zero, so the
// same envelope legitimately arrives twice.
export function createEventFeed({
  client,
  sessions,
  ensureEntry,
  streamLog,
  setStatus,
  onSessionEvent,
  isSelected,
  errorMessage,
}) {
  const seen = new Set();

  const ingest = (event) => {
    const key = `${event.stream_id}:${event.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (event.stream_id === 'admission') {
      if (event.type === 'session_throttled') streamLog.showTransient('bad', throttleLine(event));
      setStatus('LIVE', 'live');
      return;
    }
    const entry = ensureEntry(event.stream_id);
    if (!entry) return;
    applySessionEvent(entry, event, streamLog.push);
    const eventTime = Date.parse(event.ts);
    entry.lastActivityAt = Number.isFinite(eventTime) ? eventTime : Date.now();
    onSessionEvent(entry, event);
    setStatus('LIVE', 'live');
  };

  const hydrate = async (streamId) => {
    try {
      const events = await client.getEvents(streamId, 0);
      for (const event of events) ingest(event);
      if (isSelected(streamId)) setStatus('LIVE', 'live');
    } catch (error) {
      streamLog.error(`event stream unavailable: ${errorMessage(error)}`, sessions.get(streamId));
      if (isSelected(streamId)) setStatus('EVENT ERROR', 'bad');
    }
  };

  return { ingest, hydrate };
}

function throttleLine(event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const retry =
    typeof payload.retry_after_ms === 'number' ? ` · retry ${payload.retry_after_ms}ms` : '';
  return `${eventClock(event.ts)} session throttled · ${payload.provider ?? 'session'} · ${
    payload.reason ?? 'admission limit'
  }${retry}`;
}
