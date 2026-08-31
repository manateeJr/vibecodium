/* global document */

// One row shape for every list the drawers hold: sessions in the History drawer, which is now the
// session manager, sessions on the cold-start home, and reports in the inbox — a report is a
// session waiting to be started, so it gets the same row rather than a shape of its own. The title
// is the row's own name whenever it has one — the drawer used to render `kind · label`
// ("session · omp") for every row, which named the provider and never the work — and a session an
// agent opened is dimmed and tagged rather than hidden.
export function historyRow({
  title,
  project,
  meta,
  status = 'done',
  preview = [],
  sub = false,
  pinned = false,
  onPin,
  pinLabel = 'session',
  onSelect,
}) {
  const button = document.createElement('button');
  button.className = 'history-item';
  button.type = 'button';
  button.dataset.status = status;
  button.dataset.sub = sub ? 'yes' : 'no';

  const heading = document.createElement('span');
  heading.className = 'history-item__title';
  heading.textContent = title;
  if (sub) {
    const tag = document.createElement('span');
    tag.className = 'history-item__tag';
    tag.textContent = 'sub';
    heading.append(tag);
  }
  if (status !== 'running' && status !== 'ready' && status !== 'live' && status !== 'external') {
    const badge = document.createElement('span');
    badge.className = 'history-item__status';
    badge.textContent = status.toUpperCase();
    heading.append(badge);
  }

  const scope = document.createElement('span');
  scope.className = 'history-item__project';
  scope.textContent = project;

  const detail = document.createElement('span');
  detail.className = 'history-item__meta';
  detail.textContent = meta;

  button.append(heading, scope, detail);
  for (const line of preview) {
    const previewLine = document.createElement('span');
    previewLine.className = 'history-item__preview';
    previewLine.textContent = line;
    button.append(previewLine);
  }
  if (onPin) {
    const pin = document.createElement('button');
    pin.className = 'history-item__pin';
    pin.type = 'button';
    pin.textContent = pinned ? 'UNPIN' : 'PIN';
    pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${pinLabel}`);
    pin.addEventListener('click', (event) => {
      event.stopPropagation();
      onPin(!pinned);
    });
    button.append(pin);
  }
  button.addEventListener('click', () => onSelect());
  return button;
}
