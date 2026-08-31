import { postCommand } from './command.js';
import { loadSeenReports, saveSeenReports } from './storage.js';

// The reports inbox is state, not a fetch. A report arrives because an app pushed it, not because
// the operator asked for anything, so the list has to be loaded and the badge has to be right
// before the drawer is ever opened — and a report_received event has to be able to refresh both
// while it is shut.
//
// Nothing here reads a report's BODY. It is whatever the producing app sent, forwarded verbatim to
// the session that will read it; the detail view prints it and vibecodium never interprets it.
//
// These commands are newer than the bundled /client.js SDK, so they go over the raw command wire.
const LIST_COMMAND = 'report.list';
const GET_COMMAND = 'report.get';
const PIN_COMMAND = 'report.pin';
const DISMISS_COMMAND = 'report.dismiss';
const PROMOTE_COMMAND = 'report.promote';
const LIST_LIMIT = 50;

export function createReportsController({ connection, onChange, onError, errorMessage }) {
  let reports = [];
  let loading = false;
  let seen = new Set(loadSeenReports());

  const refresh = async () => {
    if (loading) return;
    loading = true;
    try {
      const result = await postCommand(LIST_COMMAND, { limit: LIST_LIMIT }, connection());
      reports = Array.isArray(result?.reports) ? [...result.reports] : [];
      prune();
    } catch (error) {
      // The last known list is kept: an inbox that empties itself on a dropped request would
      // report "no reports" for reports that are still sitting on disk.
      onError(`reports unavailable: ${errorMessage(error)}`);
    } finally {
      loading = false;
      onChange();
    }
  };

  // A dismissed or expired report never comes back, so its read mark goes with it rather than
  // accumulating in localStorage for the life of the install.
  const prune = () => {
    const live = new Set(reports.map((report) => report.id));
    const kept = [...seen].filter((id) => live.has(id));
    if (kept.length === seen.size) return;
    seen = new Set(kept);
    saveSeenReports(kept);
  };

  const markSeen = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    saveSeenReports([...seen]);
    onChange();
  };

  const pin = async (id, pinned) => {
    try {
      const result = await postCommand(PIN_COMMAND, { id, pinned }, connection());
      const next = result?.pinned === true;
      reports = reports.map((report) => (report.id === id ? { ...report, pinned: next } : report));
    } catch (error) {
      onError(`report pin failed: ${errorMessage(error)}`);
    }
    onChange();
  };

  const dismiss = async (id) => {
    try {
      await postCommand(DISMISS_COMMAND, { id }, connection());
    } catch (error) {
      onError(`report dismiss failed: ${errorMessage(error)}`);
      return false;
    }
    reports = reports.filter((report) => report.id !== id);
    prune();
    onChange();
    return true;
  };

  return {
    get reports() {
      return reports;
    },
    get unread() {
      return reports.filter((report) => !seen.has(report.id)).length;
    },
    find: (id) => reports.find((report) => report.id === id),
    isSeen: (id) => seen.has(id),
    markSeen,
    refresh,
    read: (id) => postCommand(GET_COMMAND, { id }, connection()),
    pin,
    dismiss,
    promote: (args) => postCommand(PROMOTE_COMMAND, args, connection()),
  };
}
