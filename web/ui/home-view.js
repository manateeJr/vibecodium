/* global document */
import { postCommand } from '../lib/command.js';
import { relativeTime } from '../lib/time.js';
import { historyRow } from './history-row.js';

// The cold start. With no active session the main column used to show an empty transcript over an
// empty composer, so the phone opened on nothing. It now opens on the operator's own last sessions
// with the tail of each transcript under them: which session this is answers itself, and resuming
// costs one tap instead of one remembered name.
//
// session.recent is newer than the bundled /client.js SDK, so it goes over the raw command wire.
const RECENT_COMMAND = 'session.recent';
const RECENT_LIMIT = 5;

export function createHomeView({ list, connection, onSelect, onError, errorMessage }) {
  let loading = false;

  const render = (sessions) => {
    list.replaceChildren();
    if (sessions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'drawer-empty';
      empty.textContent = 'No sessions yet · describe a task below to start one.';
      list.append(empty);
      return;
    }
    for (const session of sessions) {
      list.append(
        historyRow({
          title: session.label || `session · ${session.provider}`,
          project: session.cwd || '(default cwd)',
          meta: `${session.state} · ${relativeTime(session.updated_at)}`,
          status: session.state,
          preview: Array.isArray(session.preview) ? session.preview : [],
          onSelect: () => onSelect(session),
        }),
      );
    }
  };

  const refresh = async () => {
    if (loading) return;
    loading = true;
    try {
      const result = await postCommand(RECENT_COMMAND, { limit: RECENT_LIMIT }, connection());
      render(Array.isArray(result?.sessions) ? result.sessions : []);
    } catch (error) {
      render([]);
      onError(`recent sessions unavailable: ${errorMessage(error)}`);
    } finally {
      loading = false;
    }
  };

  return { refresh };
}
