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
      matchesQuery(query, entry.label, entry.cwd, entry.project, entry.stream_id),
    );
    const machine = machineEntries.filter((entry) =>
      matchesQuery(query, entry.title, entry.cwd, entry.source, entry.ref),
    );
    if (live.length === 0)
      liveList.append(emptyItem(query ? 'No matching live sessions.' : 'No live sessions.'));
    else renderLiveGroups(liveList, live, (entry) => onLiveSelect(entry.stream_id));
    if (machine.length === 0)
      machineList.append(
        emptyItem(query ? 'No matching machine sessions.' : 'No machine sessions found.'),
      );
    for (const entry of machine) machineList.append(historyItem(entry, onMachineSelect, true));
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

function renderLiveGroups(target, entries, onSelect) {
  const groups = new Map();
  for (const entry of entries) {
    const project = entry.project?.trim() || 'Scratch';
    const group = groups.get(project) ?? [];
    group.push(entry);
    groups.set(project, group);
  }
  for (const [project, grouped] of groups) {
    const section = document.createElement('section');
    section.className = 'history-group';
    const heading = document.createElement('h4');
    heading.className = 'history-group__title';
    heading.textContent = project;
    const list = document.createElement('div');
    list.className = 'history-group__list';
    for (const entry of grouped) list.append(historyItem(entry, onSelect));
    section.append(heading, list);
    target.append(section);
  }
}

function historyItem(entry, onSelect, machine = false) {
  const button = document.createElement('button');
  button.className = 'history-item';
  button.type = 'button';
  button.dataset.status = entry.status;
  button.innerHTML = `<span class="history-item__title"></span><span class="history-item__meta"></span>`;
  button.querySelector('.history-item__title').textContent = machine
    ? entry.title || entry.ref
    : `${entry.kind} · ${entry.label}`;
  button.querySelector('.history-item__meta').textContent = machine
    ? `${entry.source} · ${entry.cwd || '(default cwd)'} · ${relativeTime(entry.updated_at)}`
    : `${entry.status} · ${entry.cwd || entry.stream_id}`;
  button.addEventListener('click', () => onSelect(entry));
  return button;
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
