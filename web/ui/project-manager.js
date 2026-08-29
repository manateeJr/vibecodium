/* global document */

export function createProjectManager({
  client,
  elements,
  errorMessage,
  onError,
  onProjectChange,
  onQuickAction,
}) {
  let projects = [];
  let selectedName = '';
  let proposed = [];
  let detecting = false;
  let saving = false;
  let detected = false;

  const activeProject = () => projects.find((project) => project.name === selectedName);

  const render = () => {
    const selected = activeProject();
    if (!selected) selectedName = '';
    elements.projectSelector.replaceChildren(new globalThis.Option('Scratch', ''));
    for (const project of projects) {
      const option = new globalThis.Option(project.name, project.name);
      option.title = project.path;
      elements.projectSelector.add(option);
    }
    elements.projectSelector.value = selected ? selected.name : '';
    elements.projectRemove.hidden = !selected;
    elements.scratchPicker.hidden = Boolean(selected);
    renderQuickActions(selected);
    updateButtons();
  };

  const renderQuickActions = (project) => {
    elements.quickActions.replaceChildren();
    const actions = project?.quickActions ?? [];
    elements.quickActions.hidden = !project || actions.length === 0;
    for (const action of actions) {
      const button = document.createElement('button');
      button.className = 'quick-action-chip';
      button.type = 'button';
      button.textContent = action.label;
      button.title = action.prompt;
      button.addEventListener('click', () => onQuickAction(project, action));
      elements.quickActions.append(button);
    }
  };

  const updateButtons = () => {
    elements.projectDetect.disabled = detecting || saving;
    elements.projectSave.disabled = detecting || saving || !detected;
    elements.projectCancel.disabled = detecting || saving;
    elements.projectAdd.disabled = detecting || saving;
    elements.projectRemove.disabled = detecting || saving;
  };

  const showForm = () => {
    elements.projectFormShell.hidden = false;
    elements.projectStatus.textContent = '';
    elements.projectProposals.hidden = true;
    elements.projectPath.focus();
  };

  const hideForm = () => {
    elements.projectFormShell.hidden = true;
    elements.projectStatus.textContent = '';
    elements.projectProposals.hidden = true;
    proposed = [];
    detected = false;
    updateButtons();
  };

  const reportError = (prefix, error) => {
    const message = `${prefix}: ${errorMessage(error)}`;
    elements.projectStatus.textContent = message;
    onError(message);
  };

  const renderProposals = () => {
    elements.projectProposals.replaceChildren();
    for (const [index, action] of proposed.entries()) {
      const row = document.createElement('div');
      row.className = 'project-proposal';
      row.dataset.actionId = action.id;

      const keepLabel = document.createElement('label');
      keepLabel.className = 'project-proposal__keep';
      const keep = document.createElement('input');
      keep.type = 'checkbox';
      keep.checked = true;
      keep.id = `project-action-${index + 1}`;
      keepLabel.append(keep, document.createTextNode('KEEP'));

      const label = document.createElement('input');
      label.type = 'text';
      label.value = action.label;
      label.dataset.actionLabel = 'yes';
      label.setAttribute('aria-label', `Quick action ${index + 1} label`);
      label.required = true;

      const prompt = document.createElement('textarea');
      prompt.value = action.prompt;
      prompt.dataset.actionPrompt = 'yes';
      prompt.setAttribute('aria-label', `Quick action ${index + 1} prompt`);
      prompt.rows = 2;
      prompt.required = true;

      row.append(keepLabel, label, prompt);
      elements.projectProposals.append(row);
    }
    elements.projectProposals.hidden = proposed.length === 0;
  };

  const detect = async () => {
    const projectPath = elements.projectPath.value.trim();
    if (!projectPath) {
      elements.projectStatus.textContent = 'project path is required';
      return;
    }
    const description = elements.projectDescription.value.trim();
    elements.projectName.value = basename(projectPath);
    detecting = true;
    proposed = [];
    detected = false;
    elements.projectStatus.textContent = 'detecting…';
    elements.projectProposals.hidden = true;
    updateButtons();
    try {
      const args = description ? { path: projectPath, description } : { path: projectPath };
      const result = await client.detectProject(args);
      proposed = result.proposed.map((action, index) => ({
        id: action.id || `action-${index + 1}`,
        label: action.label || `Action ${index + 1}`,
        prompt: action.prompt || '',
      }));
      detected = true;
      renderProposals();
      elements.projectStatus.textContent = `${proposed.length} quick actions proposed`;
    } catch (error) {
      reportError('project detection failed', error);
    } finally {
      detecting = false;
      updateButtons();
    }
  };

  const readKeptActions = () => {
    const actions = [];
    for (const row of elements.projectProposals.querySelectorAll('[data-action-id]')) {
      const keep = row.querySelector('input[type="checkbox"]');
      if (!keep?.checked) continue;
      const label = row.querySelector('[data-action-label]')?.value.trim();
      const prompt = row.querySelector('[data-action-prompt]')?.value.trim();
      if (label && prompt) actions.push({ id: row.dataset.actionId, label, prompt });
    }
    return actions;
  };

  const save = async () => {
    const projectPath = elements.projectPath.value.trim();
    const name = elements.projectName.value.trim() || basename(projectPath);
    if (!projectPath || !name) {
      elements.projectStatus.textContent = 'project name and path are required';
      return;
    }
    saving = true;
    elements.projectStatus.textContent = 'saving…';
    updateButtons();
    try {
      const result = await client.saveProject({
        name,
        path: projectPath,
        description: elements.projectDescription.value.trim(),
        quickActions: readKeptActions(),
      });
      projects = [
        ...projects.filter((project) => project.name !== result.project.name),
        result.project,
      ];
      selectedName = result.project.name;
      render();
      await load();
      selectedName = result.project.name;
      render();
      hideForm();
      onProjectChange(activeProject());
    } catch (error) {
      reportError('project save failed', error);
    } finally {
      saving = false;
      updateButtons();
    }
  };

  const remove = async () => {
    const project = activeProject();
    if (!project) return;
    saving = true;
    elements.projectStatus.textContent = 'removing…';
    updateButtons();
    try {
      const result = await client.removeProject({ name: project.name });
      if (!result.removed) {
        elements.projectStatus.textContent = 'project was not removed';
        return;
      }
      selectedName = '';
      projects = projects.filter((item) => item.name !== project.name);
      render();
      await load();
      onProjectChange(undefined);
    } catch (error) {
      reportError('project removal failed', error);
    } finally {
      saving = false;
      updateButtons();
    }
  };

  const load = async () => {
    try {
      const result = await client.listProjects();
      projects = [...result.projects];
      if (!activeProject()) selectedName = '';
      render();
      return projects;
    } catch (error) {
      reportError('project list failed', error);
      return projects;
    }
  };

  elements.projectSelector.addEventListener('change', () => {
    selectedName = elements.projectSelector.value;
    render();
    onProjectChange(activeProject());
  });
  elements.projectAdd.addEventListener('click', showForm);
  elements.projectRemove.addEventListener('click', () => void remove());
  elements.projectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void detect();
  });
  elements.projectSave.addEventListener('click', () => void save());
  elements.projectCancel.addEventListener('click', hideForm);

  render();

  return {
    load,
    selectedProject: activeProject,
    selectProject(name) {
      selectedName = projects.some((project) => project.name === name) ? name : '';
      render();
      onProjectChange(activeProject());
    },
  };
}

function basename(value) {
  const normalized = value.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || normalized;
}
