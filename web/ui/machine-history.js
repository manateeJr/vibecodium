import { historyLines, readMachineTurns } from '../lib/machine-read.js';
import { eventClock } from '../lib/time.js';

// The read-only view of a machine-owned session used to be four lines of metadata: the provider,
// the cwd, and a promise that sending would continue it. That is not enough to decide whether to
// continue it — the operator has to see what the session was doing.
//
// So the header keeps a placeholder line and this fills it in, once, with the transcript the
// control plane parsed. The lines land in `entry.lines`, which is the same array the event feed
// pushes into: continuing the session carries them forward and live turns append below them, so
// nothing is fetched twice and nothing is rendered twice.
export function createMachineHistory({ connection, getEntry, render, errorMessage }) {
  const requested = new Set();

  const settle = (streamId, lines) => {
    const entry = getEntry(streamId);
    if (!entry) return;
    entry.lines = [...entry.lines.filter((line) => line.placeholder !== true), ...lines];
    render();
  };

  const load = async (entry) => {
    if (requested.has(entry.stream_id)) return;
    requested.add(entry.stream_id);
    if (!entry.ref || (entry.label !== 'omp' && entry.label !== 'codex')) {
      settle(entry.stream_id, [meta(`no readable transcript for a ${entry.label} session`)]);
      return;
    }
    try {
      const { turns, note } = await readMachineTurns({
        source: entry.label,
        ref: entry.ref,
        connection,
      });
      const lines = historyLines(turns);
      settle(entry.stream_id, [
        ...(note ? [meta(note)] : []),
        ...(lines.length > 0 ? lines : [meta('this transcript has no readable turns yet')]),
      ]);
    } catch (error) {
      // Dropped from `requested` so re-selecting the session retries: a control plane that was
      // restarting is the likeliest reason this failed, and the operator's retry is a tap.
      requested.delete(entry.stream_id);
      settle(entry.stream_id, [
        {
          cls: 'bad',
          text: `${eventClock(new Date().toISOString())} transcript unavailable · ${errorMessage(
            error,
          )} · reselect this session to retry`,
          markdown: false,
        },
      ]);
    }
  };

  return { load };
}

function meta(text) {
  return { cls: 'meta', text, markdown: false };
}
