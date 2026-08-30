import { postCommand } from './command.js';
import { eventClock } from './time.js';

// Reading a machine-owned session's actual transcript. The parse is the control plane's job — it
// is the only side that can see omp's JSONL or codex's store — so the phone asks for turns and
// gets turns, and never tries to guess at a file it cannot read.
//
// The tail is what matters on a phone. A limit keeps a six-hour session from arriving as one
// unscrollable wall, and the control plane is free to return fewer.
const HISTORY_LIMIT = 60;

// `note` is how the control plane says "this source parsed to nothing, and here is why" without
// inventing turns to fill the gap. It is rendered as its own meta line, above whatever came back.
export async function readMachineTurns({ source, ref, connection, limit = HISTORY_LIMIT }) {
  const value = await postCommand('machine.read', { source, ref, limit }, connection());
  return {
    turns: Array.isArray(value?.turns) ? value.turns : [],
    note: typeof value?.note === 'string' ? value.note.trim() : '',
  };
}

// Turns become the same line shapes the event feed pushes, so the transcript renders read history
// and live output through one path: `you`/`agent` classes, the `agent · ` prefix the markdown
// renderer splits on, and nothing bespoke to tell a reader this part came from a file.
export function historyLines(turns) {
  const lines = [];
  for (const turn of turns) {
    const text = String(turn?.text ?? '').trim();
    if (text === '') continue;
    lines.push(
      turn.role === 'user'
        ? { cls: 'you', text: `${stamp(turn.ts)}you · ${text}`, markdown: false }
        : { cls: 'agent', text: `${stamp(turn.ts)}agent · ${text}`, markdown: true },
    );
  }
  return lines;
}

// A turn the harness never timestamped is still a turn; it loses its clock rather than its line,
// which is why this does not fall back to eventClock's `--:--:--` placeholder.
function stamp(ts) {
  return Number.isFinite(Date.parse(String(ts ?? ''))) ? `${eventClock(ts)} ` : '';
}
