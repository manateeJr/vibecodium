/* global document */
import { formatBytes } from '../lib/bytes.js';
import { relativeTime } from '../lib/time.js';

// One report, everything vibecodium knows about it, and the only four things that can be done with
// it: promote it into a new session, send it into the session already on screen, pin it out of the
// 30-day sweep, or dismiss it.
//
// The body is printed as JSON and nothing else happens to it. The prompt that carries a report into
// a session is composed SERVER-side — the orientation lines and one `Attached file:` line per file
// — because the payload sits on the control plane's disk and the phone never holds it.
const DEFAULT_PROVIDER = 'omp';
const NO_SESSION_REASON = 'Open a session first · then this sends the report into it.';

export function createReportDetail({
  panel,
  controller,
  getSelectedSessionId,
  onPromoted,
  onDismissed,
  errorMessage,
}) {
  let current = '';
  let payload;
  let status = '';
  let tone = 'ok';
  let busy = false;
  let confirming = false;

  // The list record is authoritative for pinned state — pinning re-writes it there — and the
  // fetched copy is the fallback for a report that has left the list under us.
  const record = () => controller.find(current) ?? payload?.report;

  const say = (text, nextTone = 'ok') => {
    status = text;
    tone = nextTone;
    render();
  };

  const open = async (id) => {
    current = id;
    payload = undefined;
    busy = false;
    confirming = false;
    say('reading report…');
    try {
      payload = await controller.read(id);
      controller.markSeen(id);
      say('');
    } catch (error) {
      say(`report unavailable · ${errorMessage(error)}`, 'bad');
    }
  };

  const run = async (label, task) => {
    if (busy) return;
    busy = true;
    say(label);
    try {
      await task();
    } finally {
      busy = false;
    }
  };

  const promote = (target) =>
    void run(target === 'new' ? 'opening a session…' : 'sending into the session…', async () => {
      const args = { id: current, target };
      if (target === 'new') args.provider = DEFAULT_PROVIDER;
      else args.session_id = getSelectedSessionId();
      try {
        const result = await controller.promote(args);
        say('');
        // A brand-new session has no name yet, so it is labelled with its provider the same way
        // session.open labels one. An existing session already has a name; leave it alone.
        onPromoted({ ...result, label: target === 'new' ? DEFAULT_PROVIDER : '' });
      } catch (error) {
        say(`promote failed · ${errorMessage(error)}`, 'bad');
      }
    });

  const pin = () =>
    void run('saving…', async () => {
      await controller.pin(current, record()?.pinned !== true);
      say('');
    });

  // Dismissing deletes the report and its payload, so the first tap only arms the second.
  const dismiss = () => {
    if (!confirming) {
      confirming = true;
      say('this deletes the report and its payload · tap CONFIRM DISMISS', 'bad');
      return;
    }
    void run('dismissing…', async () => {
      const gone = await controller.dismiss(current);
      confirming = false;
      if (gone) onDismissed();
      else say('dismiss failed · the report is still here', 'bad');
    });
  };

  const actionRow = (report) => {
    const sessionId = getSelectedSessionId();
    const row = document.createElement('div');
    row.className = 'report-detail__actions';
    row.append(
      actionButton({
        label: 'PROMOTE TO NEW SESSION',
        disabled: busy,
        onClick: () => promote('new'),
      }),
      actionButton({
        label: 'SEND INTO SESSION',
        disabled: busy || sessionId === '',
        reason: sessionId === '' ? NO_SESSION_REASON : '',
        onClick: () => promote('existing'),
      }),
      actionButton({
        label: report.pinned === true ? 'UNPIN' : 'PIN',
        disabled: busy,
        onClick: () => pin(),
      }),
      actionButton({
        label: confirming ? 'CONFIRM DISMISS' : 'DISMISS',
        disabled: busy,
        tone: 'bad',
        onClick: () => dismiss(),
      }),
    );
    return row;
  };

  const render = () => {
    panel.replaceChildren();
    const report = record();
    if (!report) {
      panel.append(text('drawer-empty', status || 'This report is gone.'));
      return;
    }
    panel.append(head(report));
    if (report.summary) panel.append(text('report-detail__summary', String(report.summary)));
    if (report.note) panel.append(text('report-detail__note', `Note: ${report.note}`));
    const files = attachmentList(report);
    if (files) panel.append(files);
    if (payload?.body_path) panel.append(text('report-detail__path', String(payload.body_path)));
    panel.append(actionRow(report));
    if (getSelectedSessionId() === '') panel.append(text('report-detail__hint', NO_SESSION_REASON));
    if (status) panel.append(statusLine(status, tone));
    panel.append(bodyBlock(payload));
  };

  return { open, render };
}

function head(report) {
  const shell = document.createElement('div');
  shell.className = 'report-detail__head';
  const title = document.createElement('h3');
  title.className = 'report-detail__title';
  title.textContent = report.title || `${report.app ?? 'unknown'} · ${report.kind ?? 'report'}`;
  const scope = [report.app || 'unknown', report.kind || 'report'];
  if (report.device) scope.push(report.device);
  shell.append(
    title,
    text('report-detail__meta', scope.join(' · ')),
    text('report-detail__meta', capturedLine(report)),
  );
  return shell;
}

function capturedLine(report) {
  const at = new Date(report.capturedAt ?? '');
  const when = Number.isNaN(at.getTime())
    ? String(report.capturedAt ?? 'unknown')
    : at.toLocaleString();
  return `Captured ${when} · ${relativeTime(report.capturedAt)} · ${expiry(report)}`;
}

function expiry(report) {
  if (report.pinned === true) return 'pinned · kept until unpinned';
  const at = new Date(report.expiresAt ?? '');
  return Number.isNaN(at.getTime()) ? 'expiry unknown' : `expires ${at.toLocaleDateString()}`;
}

function attachmentList(report) {
  const attachments = Array.isArray(report.attachments) ? report.attachments : [];
  if (attachments.length === 0) return undefined;
  const shell = document.createElement('div');
  shell.className = 'report-detail__files';
  shell.append(text('entry-label', 'ATTACHMENTS'));
  for (const attachment of attachments) {
    const size = formatBytes(attachment.bytes);
    const type = attachment.contentType || 'unknown type';
    shell.append(text('report-detail__file', `${attachment.filename} · ${size} · ${type}`));
  }
  return shell;
}

// Opaque by contract: whatever the producing app sent, printed. A body that somehow is not JSON is
// still shown rather than swallowed — the operator promotes it either way.
function bodyBlock(payload) {
  const pre = document.createElement('pre');
  pre.className = 'report-detail__body';
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', 'Report body');
  pre.textContent = payload ? bodyText(payload.body) : 'reading…';
  return pre;
}

function bodyText(body) {
  if (body === undefined) return '(this report has no body)';
  try {
    return JSON.stringify(body, null, 2) ?? String(body);
  } catch {
    return String(body);
  }
}

function actionButton({ label, onClick, disabled = false, reason = '', tone = '' }) {
  const button = document.createElement('button');
  button.className = 'project-form__button';
  button.type = 'button';
  button.textContent = label;
  button.disabled = disabled;
  if (reason) button.title = reason;
  if (tone) button.dataset.tone = tone;
  button.addEventListener('click', () => onClick());
  return button;
}

function statusLine(status, tone) {
  const node = text('report-detail__status', status);
  node.setAttribute('role', 'status');
  node.dataset.tone = tone;
  return node;
}

function text(className, content) {
  const node = document.createElement('p');
  node.className = className;
  node.textContent = content;
  return node;
}
