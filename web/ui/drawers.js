/* global document */
import { loadDefaultHarness, saveDefaultHarness } from '../lib/storage.js';
import { relativeTime } from '../lib/time.js';

export function createHistoryDrawer({
  drawer,
  toggle,
  closeButton,
  searchInput,
  liveList,
  machineList,
  onLiveSelect,
  onMachineSelect,
  onOpen,
}) {
  let liveEntries = [];
  let machineEntries = [];
  let query = '';
  toggle.addEventListener('click', () => {
    const open = drawer.hidden;
    drawer.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) void onOpen();
  });
  closeButton.addEventListener('click', () => close());
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    render();
  });

  const render = () => {
    liveList.replaceChildren();
    machineList.replaceChildren();
    const live = liveEntries.filter((entry) =>
      matchesQuery(query, entry.label, entry.cwd, entry.stream_id),
    );
    const machine = machineEntries.filter((entry) =>
      matchesQuery(query, entry.title, entry.cwd, entry.source, entry.ref),
    );
    if (live.length === 0)
      liveList.append(emptyItem(query ? 'No matching live sessions.' : 'No live sessions.'));
    for (const entry of live) {
      const button = document.createElement('button');
      button.className = 'history-item';
      button.type = 'button';
      button.dataset.status = entry.status;
      button.innerHTML = `<span class="history-item__title"></span><span class="history-item__meta"></span>`;
      button.querySelector('.history-item__title').textContent = `${entry.kind} · ${entry.label}`;
      button.querySelector('.history-item__meta').textContent =
        `${entry.status} · ${entry.cwd || entry.stream_id}`;
      button.addEventListener('click', () => onLiveSelect(entry.stream_id));
      liveList.append(button);
    }
    if (machine.length === 0)
      machineList.append(
        emptyItem(query ? 'No matching machine sessions.' : 'No machine sessions found.'),
      );
    for (const entry of machine) {
      const button = document.createElement('button');
      button.className = 'history-item';
      button.type = 'button';
      button.innerHTML = `<span class="history-item__title"></span><span class="history-item__meta"></span>`;
      button.querySelector('.history-item__title').textContent = entry.title || entry.ref;
      button.querySelector('.history-item__meta').textContent =
        `${entry.source} · ${entry.cwd || '(default cwd)'} · ${relativeTime(entry.updated_at)}`;
      button.addEventListener('click', () => onMachineSelect(entry));
      machineList.append(button);
    }
  };

  const close = () => {
    drawer.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  render();
  return {
    renderLive(entries) {
      liveEntries = [...entries];
      render();
    },
    renderMachine(entries) {
      machineEntries = [...entries];
      render();
    },
    close,
  };
}

export function createSettingsDrawer({
  drawer,
  toggle,
  closeButton,
  token,
  tokenState,
  harness,
  onTokenInput,
  onTokenCommit,
}) {
  harness.value = loadDefaultHarness();
  toggle.addEventListener('click', () => {
    const open = drawer.hidden;
    drawer.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  closeButton.addEventListener('click', () => close());
  token.addEventListener('input', () => {
    onTokenInput(token.value.trim());
    renderTokenState(token, tokenState);
  });
  token.addEventListener('change', () => onTokenCommit(token.value.trim()));
  harness.addEventListener('change', () => {
    saveDefaultHarness(harness.value);
  });

  const close = () => {
    drawer.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  renderTokenState(token, tokenState);
  return { close, renderTokenState: () => renderTokenState(token, tokenState) };
}

function matchesQuery(query, ...values) {
  return (
    !query ||
    values.some((value) =>
      String(value ?? '')
        .toLowerCase()
        .includes(query),
    )
  );
}

function renderTokenState(token, state) {
  const isSet = Boolean(token.value.trim());
  state.textContent = isSet ? 'set' : 'not set';
  state.dataset.set = isSet ? 'yes' : 'no';
}

function emptyItem(text) {
  const item = document.createElement('div');
  item.className = 'drawer-empty';
  item.textContent = text;
  return item;
}
