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
  archived = false,
  onPin,
  pinLabel = 'session',
  onArchive,
  onSelect,
}) {
  const button = document.createElement('button');
  button.className = 'history-item';
  button.type = 'button';
  button.dataset.status = status;
  button.dataset.sub = sub ? 'yes' : 'no';
  button.dataset.archived = archived ? 'yes' : 'no';
  button.dataset.swipe = 'closed';

  const content = document.createElement('span');
  content.className = 'history-item__content';

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

  content.append(heading, scope, detail);
  for (const line of preview) {
    const previewLine = document.createElement('span');
    previewLine.className = 'history-item__preview';
    previewLine.textContent = line;
    content.append(previewLine);
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
    content.append(pin);
  }
  button.append(content);

  if (onArchive) {
    const archiveButton = document.createElement('button');
    archiveButton.className = 'history-item__archive';
    archiveButton.type = 'button';
    archiveButton.textContent = archived ? 'RESTORE' : 'ARCHIVE';
    archiveButton.setAttribute('aria-label', `${archived ? 'Restore' : 'Archive'} ${title}`);
    archiveButton.tabIndex = -1;
    archiveButton.setAttribute('aria-hidden', 'true');
    button.append(archiveButton);

    const swipeWidth = 88;
    const swipeThreshold = 48;
    let startX = 0;
    let startY = 0;
    let baseOffset = 0;
    let horizontal = false;
    let ignored = false;
    let suppressClick = false;

    const setOpen = (open) => {
      button.dataset.swipe = open ? 'open' : 'closed';
      archiveButton.tabIndex = open ? 0 : -1;
      archiveButton.setAttribute('aria-hidden', String(!open));
      content.style.transform = '';
    };

    const resetPointer = () => {
      horizontal = false;
      ignored = false;
      startX = 0;
      startY = 0;
      baseOffset = button.dataset.swipe === 'open' ? swipeWidth : 0;
      button.classList.remove('history-item--dragging');
    };

    archiveButton.addEventListener('click', (event) => {
      event.stopPropagation();
      setOpen(false);
      onArchive(!archived);
    });

    button.addEventListener('pointerdown', (event) => {
      if (event.isPrimary === false) return;
      suppressClick = false;
      startX = event.clientX;
      startY = event.clientY;
      baseOffset = button.dataset.swipe === 'open' ? swipeWidth : 0;
      horizontal = false;
      ignored = false;
      button.classList.remove('history-item--dragging');
    });
    button.addEventListener(
      'pointermove',
      (event) => {
        if (event.isPrimary === false || ignored) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!horizontal) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
          if (Math.abs(dx) <= Math.abs(dy)) {
            ignored = true;
            suppressClick = true;
            return;
          }
          horizontal = true;
          suppressClick = true;
          button.classList.add('history-item--dragging');
          button.setPointerCapture?.(event.pointerId);
        }
        event.preventDefault();
        const offset = Math.max(0, Math.min(swipeWidth, baseOffset - dx));
        content.style.transform = `translateX(${-offset}px)`;
      },
      { passive: false },
    );
    button.addEventListener('pointerup', (event) => {
      if (event.isPrimary === false) return;
      if (horizontal) {
        const dx = event.clientX - startX;
        const offset = Math.max(0, Math.min(swipeWidth, baseOffset - dx));
        setOpen(offset >= swipeThreshold);
      }
      resetPointer();
    });
    button.addEventListener('pointercancel', () => {
      if (horizontal) setOpen(button.dataset.swipe === 'open');
      resetPointer();
    });

    button.addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      onSelect();
    });
  } else {
    button.addEventListener('click', () => onSelect());
  }
  return button;
}
