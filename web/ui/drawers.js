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
  liveList,
  machineList,
  newButton,
  newFlow,
  newStart,
  presetRow,
  onLiveSelect,
  onMachineSelect,
  onNew,
  onPreset,
  onOpen,
  getShowAgents = () => false,
}) {
  let liveItems = [];
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

  const render = () => {
    liveList.replaceChildren();
    machineList.replaceChildren();
    const showAgents = getShowAgents();
    const live = liveItems
      .filter(
        (item) =>
          (showAgents || item.origin !== 'agent') &&
          matchesEntry(item, query, selectedProject, registeredProjects),
      )
      .sort(compareActivity);
    const machine = machineEntries
      .filter(
        (entry) =>
          (showAgents || entry.kind !== 'subagent') &&
          matchesEntry(entry, query, selectedProject, registeredProjects),
      )
      .sort(compareActivity);
    if (live.length === 0)
      liveList.append(
        emptyItem(query || selectedProject ? 'No matching sessions.' : 'No sessions.'),
      );
    else renderLiveGroups(liveList, live, onLiveSelect, registeredProjects);
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

  // The project's adopted skills and quick actions: curated first messages for the session `+ NEW`
  // is about to start, which is the only place they still make sense.
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
    renderMachine(entries) {
      machineEntries = [...entries];
      render();
    },
    setProjects(projects) {
      registeredProjects = [...projects];
      renderProjectFilter();
      render();
    },
    setPresets(next) {
      presets = [...next];
      renderPresets();
    },
    // The header's project affordance lands here: one tap from the main column to the picker.
    openNewFlow() {
      open();
      setNewFlow(true);
    },
    close,
  };
}

function renderLiveGroups(target, items, onSelect, projects) {
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
    for (const item of grouped) list.append(liveRow(item, onSelect, projects));
    section.append(heading, list);
    target.append(section);
  }
}

// D8: the session's own name when it has one, `kind · provider` otherwise. Sessions an agent opened
// stay listed — the Settings toggle decides that — but they read as somebody else's work.
function liveRow(item, onSelect, projects) {
  const kind = item.external ? 'machine' : 'session';
  return historyRow({
    title: item.label || `${kind} · ${item.provider}`,
    project: projectForEntry(item, projects),
    meta: `${item.status} · ${item.cwd || item.stream_id}`,
    status: item.status,
    sub: item.origin === 'agent',
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
  onTokenInput,
  onTokenCommit,
  onToggleAgents,
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
