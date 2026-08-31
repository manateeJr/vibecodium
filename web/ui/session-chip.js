/* global document */

// The active session, and every verb that belongs to it, behind one header control. It replaces
// the whole session bar (status, rename, stop) and takes the live-mirror toggle the deleted
// view-tabs strip used to carry, so the main column is header → transcript → composer and nothing
// else competes with the message flow.
//
// The menu is a list of item descriptors on purpose: the ratified mid-session model switch (#66)
// lands as one more entry in `items()` instead of as another control in the header row.
const NO_SESSION = 'NO SESSION';

export function createSessionChip({
  button,
  label,
  dot,
  menu,
  onRename,
  onStop,
  onToggleMirror,
  isMirrorVisible,
}) {
  const state = { entry: undefined, stopping: false };
  let open = false;
  let renaming = false;

  const close = () => {
    open = false;
    renaming = false;
    render();
  };

  const items = () => {
    const entry = state.entry;
    const live = entry?.status === 'running' || entry?.status === 'ready';
    return [
      {
        id: 'rename',
        label: 'RENAME',
        enabled: Boolean(entry) && !entry.external,
        run: () => startRename(),
      },
      {
        id: 'stop',
        label: 'STOP',
        tone: 'bad',
        enabled: Boolean(live) && !state.stopping,
        run: () => {
          close();
          onStop();
        },
      },
      {
        id: 'mirror',
        label: 'LIVE MIRROR',
        enabled: true,
        on: isMirrorVisible(),
        run: () => {
          close();
          onToggleMirror();
        },
      },
      { id: 'cwd', label: 'CWD', detail: entry?.cwd || '(default cwd)' },
    ];
  };

  const startRename = () => {
    renaming = true;
    render();
  };

  const menuItem = (item) => {
    if (item.detail !== undefined) {
      const row = document.createElement('div');
      row.className = 'session-menu__detail';
      const name = document.createElement('span');
      name.className = 'entry-label';
      name.textContent = item.label;
      const value = document.createElement('span');
      value.className = 'session-menu__value';
      value.textContent = item.detail;
      row.append(name, value);
      return row;
    }
    const action = document.createElement('button');
    action.className = 'session-menu__item';
    action.type = 'button';
    action.dataset.tone = item.tone ?? 'plain';
    action.setAttribute('role', 'menuitem');
    action.disabled = !item.enabled;
    action.textContent =
      item.on === undefined ? item.label : `${item.label} · ${item.on ? 'ON' : 'OFF'}`;
    if (item.on !== undefined) action.setAttribute('aria-pressed', String(item.on));
    action.addEventListener('click', () => item.run());
    return action;
  };

  // Commit on blur, because on a phone the keyboard closing is the usual way out of a field and
  // discarding the typed label there would be the more expensive mistake. Escape still cancels.
  const renameField = () => {
    const entry = state.entry;
    const field = document.createElement('input');
    field.className = 'session-menu__rename';
    field.type = 'text';
    field.value = entry?.sessionLabel ?? '';
    field.placeholder = entry?.label ?? 'session';
    field.setAttribute('aria-label', 'Session name');
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      const label = value?.trim();
      close();
      if (label && label !== (entry?.sessionLabel ?? '')) onRename(entry, label);
    };
    field.addEventListener('blur', () => settle(field.value));
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        settle(field.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        settle(undefined);
      }
    });
    globalThis.setTimeout(() => {
      field.focus();
      field.select();
    }, 0);
    return field;
  };

  const render = () => {
    const entry = state.entry;
    const status = chipStatus(entry);
    dot.dataset.status = status;
    label.textContent = entry
      ? `${status} · ${entry.sessionLabel || entry.label || 'session'}`
      : NO_SESSION;
    button.dataset.status = status;
    button.title = entry ? entry.cwd || entry.project || entry.stream_id : 'No active session';
    button.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
    if (!open) {
      menu.replaceChildren();
      return;
    }
    menu.replaceChildren(...(renaming ? [renameField()] : items().map(menuItem)));
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    open = !open;
    renaming = false;
    render();
  });
  menu.addEventListener('click', (event) => event.stopPropagation());
  // A menu on a phone closes when the operator taps anywhere else; nothing here is a modal.
  document.addEventListener('click', () => {
    if (open && !renaming) close();
  });

  render();

  return {
    update(next) {
      Object.assign(state, next);
      // A background refresh must not yank the rename field out from under the owner.
      if (renaming) return;
      render();
    },
  };
}

function chipStatus(entry) {
  if (!entry) return 'none';
  if (entry.status === 'external') return 'ext';
  if (entry.status === 'running' || entry.status === 'ready') return 'live';
  return entry.status === 'failed' ? 'failed' : 'done';
}
