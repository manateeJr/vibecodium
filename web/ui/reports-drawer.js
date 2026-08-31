/* global document */
import { createReportsController } from '../lib/reports-controller.js';
import { createReportDetail } from './report-detail.js';
import { createReportsView } from './reports-view.js';

// REPORTS is a peer of HISTORY: a durable inbox of debug reports an app pushed at the control
// plane, each one a session waiting to be started with its payload already attached. The badge on
// the toggle is the point — a report that arrived while the phone was in a pocket has to be
// visible without opening anything.
//
// The shell markup is built here instead of in index.html because the surface is self-contained
// (a toggle, a drawer, a list, a detail) and index.html is at its line ceiling. Everything below
// reuses the drawer, header-button and history-row classes the static shell already defines.
export function createReportsDrawer({
  connection,
  onOpen,
  onPromoted,
  getSelectedSessionId,
  onError,
  errorMessage,
}) {
  const parts = mount();
  const controller = createReportsController({
    connection,
    onChange: () => renderList(),
    onError,
    errorMessage,
  });
  const view = createReportsView({
    list: parts.list,
    controller,
    onSelect: (id) => void showDetail(id),
  });
  const detail = createReportDetail({
    panel: parts.detail,
    controller,
    getSelectedSessionId,
    onPromoted: (result) => {
      close();
      onPromoted(result);
    },
    onDismissed: () => showList(),
    errorMessage,
  });

  function renderList() {
    view.render();
    const unread = controller.unread;
    const total = controller.reports.length;
    parts.badge.textContent = unread > 0 ? `${unread}/${total}` : String(total);
    parts.badge.dataset.unread = unread > 0 ? 'yes' : 'no';
    parts.badge.hidden = total === 0;
  }

  const showList = () => {
    parts.detail.hidden = true;
    parts.back.hidden = true;
    parts.list.hidden = false;
  };

  const showDetail = async (id) => {
    parts.list.hidden = true;
    parts.back.hidden = false;
    parts.detail.hidden = false;
    await detail.open(id);
  };

  const open = () => {
    parts.drawer.hidden = false;
    parts.toggle.setAttribute('aria-expanded', 'true');
    onOpen();
    void controller.refresh();
  };

  const close = () => {
    if (parts.drawer.hidden) return;
    parts.drawer.hidden = true;
    parts.toggle.setAttribute('aria-expanded', 'false');
    showList();
  };

  parts.toggle.addEventListener('click', () => (parts.drawer.hidden ? open() : close()));
  parts.close.addEventListener('click', () => close());
  parts.back.addEventListener('click', () => showList());

  renderList();
  // Loaded before anybody asks for it: the badge is the only thing that says a report is waiting.
  void controller.refresh();

  return {
    close,
    refresh: () => void controller.refresh(),
  };
}

function mount() {
  const toggle = headerButton('REPORTS');
  toggle.id = 'reports-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'reports-drawer');
  const badge = document.createElement('span');
  badge.className = 'header-button__badge';
  badge.hidden = true;
  toggle.append(badge);
  const actions = document.querySelector('.top-actions');
  actions.insertBefore(toggle, actions.querySelector('.connection'));

  const back = headerButton('BACK');
  back.id = 'reports-back';
  back.hidden = true;
  const close = headerButton('CLOSE');
  close.id = 'reports-close';
  const controls = document.createElement('div');
  controls.className = 'drawer-heading__actions';
  controls.append(back, close);
  const title = document.createElement('h2');
  title.textContent = 'REPORTS';
  const heading = document.createElement('div');
  heading.className = 'drawer-heading';
  heading.append(title, controls);

  const list = document.createElement('div');
  list.id = 'reports-list';
  list.className = 'history-list';
  const detail = document.createElement('section');
  detail.id = 'report-detail';
  detail.className = 'report-detail';
  detail.hidden = true;
  detail.setAttribute('aria-label', 'Report');

  const drawer = document.createElement('aside');
  drawer.id = 'reports-drawer';
  drawer.className = 'drawer drawer--reports';
  drawer.hidden = true;
  drawer.setAttribute('aria-label', 'Debug reports');
  drawer.append(heading, list, detail);
  document.querySelector('.app-shell').append(drawer);

  return { toggle, badge, drawer, list, detail, back, close };
}

function headerButton(label) {
  const button = document.createElement('button');
  button.className = 'header-button';
  button.type = 'button';
  button.textContent = label;
  return button;
}
