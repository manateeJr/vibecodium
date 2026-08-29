/* global document */
import { loadRecentProjects, rememberRecentProject } from '../lib/storage.js';

export function createProjectPicker({ filter, select, recent, onChange }) {
  let workspaces = [];
  let recentPaths = loadRecentProjects();

  const render = () => {
    const current = select.value;
    const query = filter.value.trim().toLowerCase();
    const visible = workspaces.filter(
      (workspace) =>
        !query ||
        workspace.name.toLowerCase().includes(query) ||
        workspace.path.toLowerCase().includes(query),
    );
    select.replaceChildren(new globalThis.Option('(default cwd)', ''));
    for (const workspace of visible)
      select.add(new globalThis.Option(`${workspace.name} · ${workspace.path}`, workspace.path));
    if (visible.some((workspace) => workspace.path === current)) select.value = current;
    renderRecent();
  };

  const renderRecent = () => {
    recent.replaceChildren();
    const available = recentPaths
      .map((path) => workspaces.find((workspace) => workspace.path === path))
      .filter((workspace) => workspace !== undefined);
    recent.hidden = available.length === 0;
    for (const workspace of available) {
      const button = document.createElement('button');
      button.className = 'project-chip';
      button.type = 'button';
      button.textContent = workspace.name;
      button.title = workspace.path;
      button.addEventListener('click', () => {
        select.value = workspace.path;
        recentPaths = rememberRecentProject(workspace.path);
        onChange(workspace.path);
        renderRecent();
      });
      recent.append(button);
    }
  };

  filter.addEventListener('input', render);
  select.addEventListener('change', () => {
    if (select.value) recentPaths = rememberRecentProject(select.value);
    onChange(select.value);
    renderRecent();
  });

  return {
    setWorkspaces(next) {
      workspaces = [...next];
      render();
    },
    selectedPath() {
      return select.value;
    },
    remember(path) {
      if (path) recentPaths = rememberRecentProject(path);
      renderRecent();
    },
  };
}
