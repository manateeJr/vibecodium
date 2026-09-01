/* global document */
import { projectForPath } from '../lib/paths.js';
import { loadDefaultHarness, saveDefaultHarness } from '../lib/storage.js';
import { relativeTime } from '../lib/time.js';
import { historyRow } from './history-row.js';

// HISTORY is the session manager. The recent-session pills that used to sit above the composer are
// gone, so this drawer is where every session — the ones this phone opened, the ones an agent
// opened, and the machine's own — is searched, filtered, switched and started. `+ NEW` opens the
// project and model pickers that used to live in the main column.
export function createHistoryDrawer({
  drawer,
  toggle,
  closeButton,
  scrollContainer,
  searchInput,
  projectFilter,
  pinnedList,
  archivedList,
  liveList,
  endedList,
  machineList,
  newButton,
  newFlow,
  newStart,
  presetRow,
  onLiveSelect,
  onRecentSelect = onLiveSelect,
  onMachineSelect,
  onPin = () => undefined,
  onArchive = () => undefined,
  onNew,
  onPreset,
  onOpen,
  getShowAgents = () => false,
  getShowAllSessions = () => false,
}) {
  let liveItems = [];
  let recentItems = [];
  let archivedItems = [];
  let machineEntries = [];
  let registeredProjects = [];
  let presets = [];
  let query = '';
  let selectedProject = '';
  let lastScrollTop = 0;

  const open = () => {
    drawer.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    void onOpen();
  };

  const close = () => {
    drawer.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  const setNewFlow = (visible) => {
    newFlow.hidden = !visible;
    newButton.setAttribute('aria-expanded', String(visible));
    if (visible) newFlow.scrollIntoView?.({ block: 'nearest' });
  };

  toggle.addEventListener('click', () => (drawer.hidden ? open() : close()));
  closeButton.addEventListener('click', () => close());
  newButton.addEventListener('click', () => setNewFlow(newFlow.hidden));
  newStart.addEventListener('click', () => {
    setNewFlow(false);
    close();
    onNew();
  });
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

  const visible = (entry, showAgents) =>
    entry.archived !== true &&
    (showAgents || entry.origin !== 'agent') &&
    (getShowAllSessions() || entry.source === 'pocket') &&
    matchesEntry(entry, query, selectedProject, registeredProjects);
  const visibleArchived = (entry, showAgents) =>
    entry.archived === true &&
    (showAgents || entry.origin !== 'agent') &&
    (getShowAllSessions() || entry.source === 'pocket') &&
    matchesEntry(entry, query, selectedProject, registeredProjects);
  const visibleLive = (entry) =>
    entry.archived !== true &&
    (getShowAllSessions() || entry.source === 'pocket') &&
    matchesQuery(
      query,
      entry.title,
      entry.label,
      entry.provider,
      entry.cwd,
      entry.source,
      entry.ref,
      entry.stream_id,
      projectForEntry(entry, registeredProjects),
    );

  const renderRows = (target, items, onSelect, emptyText = 'No sessions.') => {
    if (items.length === 0) {
      target.append(emptyItem(query || selectedProject ? 'No matching sessions.' : emptyText));
      return;
    }
    for (const item of items) {
      target.append(sessionRecentRow(item, onSelect, onPin, onArchive, registeredProjects));
    }
  };

  const render = () => {
    pinnedList.replaceChildren();
    archivedList?.replaceChildren();
    liveList.replaceChildren();
    endedList.replaceChildren();
    machineList.replaceChildren();
    const showAgents = getShowAgents();
    const live = liveItems
      .filter((item) => isLive(item.status) && visibleLive(item))
      .sort(compareActivity);
    const recent = [
      ...recentItems.filter((item) => visible(item, showAgents)),
      ...archivedItems.filter((item) => visibleArchived(item, showAgents)),
    ];
    const grouped = groupRecentItems(recent);
    const pinned = grouped.pinned.sort(compareActivity);
    const ended = grouped.ended.sort(compareActivity);
    const archived = grouped.archived.sort(compareActivity);
    const machine = machineEntries
      .filter(
        (entry) =>
          getShowAllSessions() &&
          (showAgents || entry.kind !== 'subagent') &&
          matchesEntry(entry, query, selectedProject, registeredProjects),
      )
      .sort(compareActivity);
    renderRows(pinnedList, pinned, onRecentSelect);
    if (live.length === 0)
      liveList.append(
        emptyItem(query || selectedProject ? 'No matching sessions.' : 'No sessions.'),
      );
    else renderLiveGroups(liveList, live, onLiveSelect, registeredProjects, onPin, onArchive);
    renderRows(endedList, ended, onRecentSelect);
    if (archivedList) renderRows(archivedList, archived, onRecentSelect, 'No archived sessions.');
    if (machine.length === 0)
      machineList.append(
        emptyItem(
          query || selectedProject ? 'No matching machine sessions.' : 'No machine sessions found.',
        ),
      );
    else
      for (const entry of machine)
        machineList.append(machineRow(entry, onMachineSelect, registeredProjects));
  };

  const renderPresets = () => {
    presetRow.replaceChildren();
    presetRow.hidden = presets.length === 0;
    for (const preset of presets) {
      const chip = document.createElement('button');
      chip.className = 'preset-chip';
      chip.type = 'button';
      chip.textContent = preset.label;
      chip.title = preset.title ?? preset.prompt ?? preset.label;
      chip.dataset.kind = preset.kind ?? 'action';
      chip.addEventListener('click', () => {
        setNewFlow(false);
        close();
        onPreset(preset);
      });
      presetRow.append(chip);
    }
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

  renderProjectFilter();
  renderPresets();
  render();
  return {
    renderLive(items) {
      liveItems = [...items];
      render();
    },
    renderRecent(items) {
      recentItems = [...items];
      render();
    },
    renderArchived(items) {
      archivedItems = [...items];
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
    setSelectedProject(name) {
      selectedProject = name || '';
      renderProjectFilter();
      render();
    },
    setPresets(next) {
      presets = [...next];
      renderPresets();
    },
    openNewFlow() {
      open();
      setNewFlow(true);
    },
    close,
  };
}

export function groupRecentItems(items) {
  const active = items.filter((item) => item.archived !== true);
  return {
    pinned: active.filter((item) => item.pinned === true),
    live: active.filter((item) => item.pinned !== true && isLive(item.state ?? item.status)),
    ended: active.filter((item) => item.pinned !== true && !isLive(item.state ?? item.status)),
    archived: items.filter((item) => item.archived === true),
  };
}

function renderLiveGroups(target, items, onSelect, projects, onPin, onArchive) {
  const groups = new Map();
  for (const item of items) {
    const project = projectForEntry(item, projects);
    const group = groups.get(project) ?? [];
    group.push(item);
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
    for (const item of grouped) list.append(liveRow(item, onSelect, projects, onPin, onArchive));
    section.append(heading, list);
    target.append(section);
  }
}

function sessionRecentRow(item, onSelect, onPin, onArchive, projects) {
  const state = item.state ?? item.status ?? 'done';
  return historyRow({
    title: item.label || `session · ${item.provider}`,
    project: projectForEntry(item, projects),
    meta: `${state} · ${relativeTime(item.updated_at)}`,
    status: state,
    preview: Array.isArray(item.preview) ? item.preview : [],
    sub: item.origin === 'agent',
    pinned: item.pinned === true,
    archived: item.archived === true,
    onPin: (pinned) => onPin(item, pinned),
    onArchive: (archived) => onArchive(item, archived),
    onSelect: () => onSelect(item),
  });
}

function isLive(status) {
  return status === 'running' || status === 'ready' || status === 'live' || status === 'external';
}

function liveRow(item, onSelect, projects, onPin, onArchive) {
  const kind = item.external ? 'machine' : 'session';
  const canArchive =
    !item.external && Boolean(item.session_id || item.stream_id?.startsWith('session:'));
  return historyRow({
    title: item.label || `${kind} · ${item.provider}`,
    project: projectForEntry(item, projects),
    meta: `${item.status} · ${item.cwd || item.stream_id}`,
    status: item.status,
    sub: item.origin === 'agent',
    pinned: item.pinned === true,
    archived: item.archived === true,
    onPin: item.session_id ? (pinned) => onPin(item, pinned) : undefined,
    onArchive: canArchive ? (archived) => onArchive(item, archived) : undefined,
    onSelect: () => onSelect(item),
  });
}

function machineRow(entry, onSelect, projects) {
  return historyRow({
    title: entry.title || entry.ref,
    project: projectForEntry(entry, projects),
    meta: `${entry.source} · ${entry.cwd || '(default cwd)'} · ${relativeTime(entry.updated_at)}`,
    status: entry.status || 'done',
    sub: entry.kind === 'subagent',
    onSelect: () => onSelect(entry),
  });
}

function matchesEntry(entry, query, selectedProject, projects) {
  const project = projectForEntry(entry, projects);
  return (
    (!selectedProject || project === selectedProject) &&
    matchesQuery(
      query,
      entry.title,
      entry.label,
      entry.provider,
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
  if (Number.isFinite(entry.time)) return entry.time;
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
  showAgents,
  showAllSessions,
  onTokenInput,
  onTokenCommit,
  onToggleAgents,
  onToggleShowAllSessions,
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
  // Set and forget: which sessions are worth listing is a preference, not a control that belongs
  // above the composer, which is what the AGENTS ON/OFF pill in the session bar had become.
  showAgents.addEventListener('change', () => onToggleAgents(showAgents.checked));
  showAllSessions.addEventListener('change', () =>
    onToggleShowAllSessions(showAllSessions.checked),
  );

  const close = () => {
    drawer.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  renderTokenState(token, tokenState);
  return {
    close,
    setShowAgents(visible) {
      showAgents.checked = visible;
    },
    setShowAllSessions(visible) {
      showAllSessions.checked = visible;
    },
  };
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
