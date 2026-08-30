/* global document */
import { projectForPath } from '../lib/paths.js';
import { loadDefaultHarness, saveDefaultHarness } from '../lib/storage.js';
import { relativeTime } from '../lib/time.js';

export function createHistoryDrawer({
  drawer,
  toggle,
  closeButton,
  scrollContainer,
  searchInput,
  projectFilter,
  liveList,
  machineList,
  onLiveSelect,
  onMachineSelect,
  onOpen,
}) {
  let liveEntries = [];
  let machineEntries = [];
  let registeredProjects = [];
  let query = '';
  let selectedProject = '';
  let lastScrollTop = 0;

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
  projectFilter.addEventListener('change', () => {
    selectedProject = projectFilter.value;
    render();
  });
  scrollContainer.addEventListener('scroll', () => {
    const scrollTop = Math.max(0, scrollContainer.scrollTop);
    if (scrollTop > lastScrollTop) scrollContainer.dataset.searchCollapsed = 'yes';
    else if (scrollTop < lastScrollTop) scrollContainer.dataset.searchCollapsed = 'no';
    lastScrollTop = scrollTop;
  });

  const render = () => {
    liveList.replaceChildren();
    machineList.replaceChildren();
    const live = liveEntries
      .filter((entry) => matchesEntry(entry, query, selectedProject, registeredProjects))
      .sort(compareActivity);
    const machine = machineEntries
      .filter((entry) => matchesEntry(entry, query, selectedProject, registeredProjects))
      .sort(compareActivity);
    if (live.length === 0)
      liveList.append(
        emptyItem(query || selectedProject ? 'No matching sessions.' : 'No sessions.'),
      );
    else
      renderLiveGroups(
        liveList,
        live,
        (entry) => onLiveSelect(entry.stream_id),
        registeredProjects,
      );
    if (machine.length === 0)
      machineList.append(
        emptyItem(
          query || selectedProject ? 'No matching machine sessions.' : 'No machine sessions found.',
        ),
      );
    else
      for (const entry of machine)
        machineList.append(historyItem(entry, onMachineSelect, true, registeredProjects));
  };

  const renderProjectFilter = () => {
    projectFilter.replaceChildren(new globalThis.Option('All projects', ''));
    const names = new Set();
    for (const project of registeredProjects) {
      if (!project.name || names.has(project.name)) continue;
      names.add(project.name);
      projectFilter.add(new globalThis.Option(project.name, project.name));
    }
    if (!names.has('Scratch')) projectFilter.add(new globalThis.Option('Scratch', 'Scratch'));
    if ([...projectFilter.options].some((option) => option.value === selectedProject))
      projectFilter.value = selectedProject;
    else {
      selectedProject = '';
      projectFilter.value = '';
    }
  };

  const close = () => {
    drawer.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  renderProjectFilter();
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
    setProjects(projects) {
      registeredProjects = [...projects];
      renderProjectFilter();
      render();
    },
    close,
  };
}

function renderLiveGroups(target, entries, onSelect, projects) {
  const groups = new Map();
  for (const entry of entries) {
    const project = projectForEntry(entry, projects);
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
    for (const entry of grouped) list.append(historyItem(entry, onSelect, false, projects));
    section.append(heading, list);
    target.append(section);
  }
}

function historyItem(entry, onSelect, machine = false, projects = []) {
  const button = document.createElement('button');
  button.className = 'history-item';
  button.type = 'button';
  button.dataset.status = entry.status || 'done';
  button.innerHTML =
    '<span class="history-item__title"></span><span class="history-item__project"></span>' +
    '<span class="history-item__meta"></span>';
  button.querySelector('.history-item__title').textContent = machine
    ? entry.title || entry.ref
    : `${entry.kind} · ${entry.label}`;
  button.querySelector('.history-item__project').textContent = projectForEntry(entry, projects);
  button.querySelector('.history-item__meta').textContent = machine
    ? `${entry.source} · ${entry.cwd || '(default cwd)'} · ${relativeTime(entry.updated_at)}`
    : `${entry.status} · ${entry.cwd || entry.stream_id}`;
  button.addEventListener('click', () => onSelect(entry));

  return button;
}
function matchesEntry(entry, query, selectedProject, projects) {
  const project = projectForEntry(entry, projects);
  return (
    (!selectedProject || project === selectedProject) &&
    matchesQuery(
      query,
      entry.title,
      entry.label,
      entry.cwd,
      entry.source,
      entry.ref,
      entry.stream_id,
      project,
    )
  );
}

function compareActivity(left, right) {
  return activityTime(right) - activityTime(left);
}

function activityTime(entry) {
  if (Number.isFinite(entry.lastActivityAt)) return entry.lastActivityAt;
  const timestamp = Date.parse(entry.updated_at ?? '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function projectForEntry(entry, projects) {
  const explicit = entry.project?.trim();
  if (explicit) return explicit;
  return projectForPath(entry.cwd, projects) || 'Scratch';
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
  onOpen,
}) {
  harness.value = loadDefaultHarness();
  toggle.addEventListener('click', () => {
    const open = drawer.hidden;
    drawer.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) onOpen();
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
