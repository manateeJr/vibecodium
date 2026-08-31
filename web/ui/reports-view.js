/* global document */
import { relativeTime } from '../lib/time.js';
import { historyRow } from './history-row.js';

// The inbox list. A report is a session waiting to be started, so it is rendered with the same row
// as every other list in the drawers — title, scope, meta, transcript-style preview — and the app
// that sent it takes the place a project would occupy.
//
// The report's own words are the only words here. `app` and `kind` are printed, never switched on:
// vibecodium does not know what an ultrack crash report is and must not learn.
const PREVIEW_LINES = 3;

export function createReportsView({ list, controller, onSelect }) {
  const render = () => {
    list.replaceChildren();
    const reports = controller.reports;
    if (reports.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'drawer-empty';
      empty.textContent = 'No reports · an app posts one to /report-intake and it lands here.';
      list.append(empty);
      return;
    }
    for (const report of reports) list.append(reportRow(report, controller, onSelect));
  };

  return { render };
}

function reportRow(report, controller, onSelect) {
  return historyRow({
    title: report.title || `${report.app ?? 'unknown'} · ${report.kind ?? 'report'}`,
    project: report.app || 'unknown',
    meta: metaLine(report),
    status: controller.isSeen(report.id) ? 'read' : 'new',
    preview: previewLines(report),
    pinned: report.pinned === true,
    pinLabel: 'report',
    onPin: (pinned) => void controller.pin(report.id, pinned),
    onSelect: () => onSelect(report.id),
  });
}

// Everything that decides whether a report is worth opening, in one line: what kind it is, how old
// it is, which device it came off, and whether it brought screenshots.
function metaLine(report) {
  const parts = [report.kind || 'report', relativeTime(report.capturedAt)];
  if (report.device) parts.push(report.device);
  const attachments = Array.isArray(report.attachments) ? report.attachments.length : 0;
  if (attachments > 0) parts.push(`${attachments} file${attachments === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function previewLines(report) {
  return String(report.summary ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, PREVIEW_LINES);
}
