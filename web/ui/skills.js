/* global document */
import {
  adoptedIds,
  missingParams,
  optionsOf,
  paramDefaults,
  promptParams,
  skillPresets,
} from '../lib/skills.js';
import { createSkillBuilder } from './skill-builder.js';

// The library is canonical; projects adopt from it and adopted skills become composer presets.
export function createSkillsPanel({
  client,
  elements,
  errorMessage,
  onError,
  getProject,
  onPresetsChange,
  onPrompt,
}) {
  let skills = [];
  let adoptions = {};
  let proposed = [];
  let loading = false;
  let busy = false;
  let pending;

  const projectName = () => getProject()?.name ?? '';

  const setStatus = (text) => {
    elements.skillStatus.textContent = text;
  };

  const report = (message) => {
    setStatus(message);
    onError(message);
  };

  const builder = createSkillBuilder({
    client,
    elements,
    errorMessage,
    onError,
    onSaved: (def) => {
      setStatus(`saved ${def.name}`);
      void refresh();
    },
  });

  const refresh = async () => {
    if (loading) return;
    loading = true;
    try {
      const result = await client.skillList();
      skills = [...result.skills];
      adoptions = { ...result.adoptions };
      render();
      onPresetsChange();
    } catch (error) {
      skills = [];
      render();
      setStatus(`skill list failed: ${errorMessage(error)}`);
    } finally {
      loading = false;
    }
  };

  const render = () => {
    elements.skillList.replaceChildren();
    const project = projectName();
    const adopted = new Set(adoptedIds(adoptions, project));
    elements.skillPropose.disabled = busy || !project;
    if (skills.length === 0) {
      elements.skillList.append(emptyRow('No skills yet.'));
      return;
    }
    for (const skill of skills)
      elements.skillList.append(
        skillRow(skill, {
          project,
          adopted: adopted.has(skill.id),
          suggested: proposed.includes(skill.id),
          busy,
          onAdopt: (adopt) => void setAdopted(skill, adopt),
          onEdit: () => builder.open(skill),
          onRemove: () => void remove(skill),
        }),
      );
  };

  const setAdopted = async (skill, adopt) => {
    const project = projectName();
    if (!project || busy) return;
    busy = true;
    setStatus(`${adopt ? 'adopting' : 'dropping'} ${skill.name}…`);
    render();
    try {
      const result = await client.skillAdopt({ project, skill_id: skill.id, adopt });
      adoptions = { ...adoptions, [project]: [...result.adopted] };
      setStatus(`${project} · ${result.adopted.length} adopted`);
      onPresetsChange();
    } catch (error) {
      report(`skill adopt failed: ${errorMessage(error)}`);
    } finally {
      busy = false;
      render();
    }
  };

  const propose = async () => {
    const project = projectName();
    if (!project || busy) return;
    busy = true;
    setStatus('detecting skills for this project…');
    render();
    try {
      const result = await client.skillPropose({ project });
      proposed = [...result.proposed];
      setStatus(
        proposed.length > 0
          ? `${proposed.length} suggested · highlighted below`
          : 'no new skills suggested',
      );
    } catch (error) {
      report(`skill detection failed: ${errorMessage(error)}`);
    } finally {
      busy = false;
      render();
    }
  };

  const remove = async (skill) => {
    if (busy || skill.builtin) return;
    busy = true;
    setStatus(`removing ${skill.name}…`);
    render();
    try {
      const result = await client.skillRemove({ id: skill.id });
      setStatus(result.removed ? `removed ${skill.name}` : 'skill was not removed');
      if (result.removed) await refresh();
    } catch (error) {
      report(`skill removal failed: ${errorMessage(error)}`);
    } finally {
      busy = false;
      render();
    }
  };

  const invoke = (id) => {
    const def = skills.find((skill) => skill.id === id);
    if (!def) {
      onError(`skill ${id} is no longer in the library`);
      return;
    }
    const params = promptParams(def);
    if (params.length === 0) {
      void run(def, {});
      return;
    }
    pending = { def, values: paramDefaults(def) };
    elements.skillInvokeTitle.textContent = def.name;
    elements.skillInvokeNote.textContent = def.approval
      ? 'asks for approval before acting'
      : def.description || '';
    elements.skillInvokeStatus.textContent = '';
    renderInvokeFields(params);
    elements.skillInvokePanel.hidden = false;
    elements.skillInvokePanel.querySelector('input, select')?.focus();
  };

  const renderInvokeFields = (params) => {
    elements.skillInvokeFields.replaceChildren();
    for (const param of params)
      elements.skillInvokeFields.append(
        invokeField(param, pending.values[param.name], (value) => {
          pending.values[param.name] = value;
        }),
      );
  };

  const submitInvoke = () => {
    if (!pending) return;
    const missing = missingParams(pending.def, pending.values);
    if (missing.length > 0) {
      elements.skillInvokeStatus.textContent = `required: ${missing.join(', ')}`;
      return;
    }
    void run(pending.def, pending.values);
  };

  const run = async (def, values) => {
    elements.skillInvokeRun.disabled = true;
    elements.skillInvokeStatus.textContent = 'resolving…';
    try {
      const result = await client.skillInvoke({ id: def.id, params: { ...values } });
      closeInvoke();
      onPrompt(result.prompt, def);
    } catch (error) {
      const message = `skill invoke failed: ${errorMessage(error)}`;
      elements.skillInvokeStatus.textContent = message;
      onError(message);
    } finally {
      elements.skillInvokeRun.disabled = false;
    }
  };

  const closeInvoke = () => {
    pending = undefined;
    elements.skillInvokePanel.hidden = true;
    elements.skillInvokeFields.replaceChildren();
    elements.skillInvokeStatus.textContent = '';
  };

  elements.skillRefresh.addEventListener('click', () => void refresh());
  elements.skillPropose.addEventListener('click', () => void propose());
  elements.skillNew.addEventListener('click', () => builder.open());
  elements.skillInvokeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitInvoke();
  });
  elements.skillInvokeCancel.addEventListener('click', closeInvoke);

  render();
  return {
    refresh,
    invoke,
    presets: () => skillPresets(skills, adoptions, projectName()),
    render,
  };
}

function skillRow(skill, view) {
  const row = document.createElement('div');
  row.className = 'skill-row';
  row.dataset.suggested = view.suggested ? 'yes' : 'no';
  const heading = document.createElement('div');
  heading.className = 'skill-row__heading';
  const name = document.createElement('span');
  name.className = 'skill-row__name';
  name.textContent = skill.name || skill.id;
  heading.append(name, tag(skill.builtin ? 'built-in' : 'custom'));
  if (skill.approval) heading.append(tag('approval'));
  if (view.suggested) heading.append(tag('suggested'));
  const description = document.createElement('span');
  description.className = 'skill-row__description';
  description.textContent = skill.description || `${skill.params.length} parameter(s)`;
  row.append(heading, description, skillActions(skill, view));
  return row;
}

function skillActions(skill, view) {
  const actions = document.createElement('div');
  actions.className = 'skill-row__actions';
  const adopt = document.createElement('label');
  adopt.className = 'skill-row__adopt';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = view.adopted;
  toggle.disabled = view.busy || !view.project;
  toggle.title = view.project ? `Adopt in ${view.project}` : 'Select a project first';
  toggle.setAttribute('aria-label', `Adopt ${skill.name}`);
  toggle.addEventListener('change', () => view.onAdopt(toggle.checked));
  adopt.append(toggle, document.createTextNode('ADOPT'));
  actions.append(adopt);
  if (skill.builtin) return actions;
  actions.append(
    rowButton('EDIT', `Edit ${skill.name}`, view.busy, view.onEdit),
    rowButton('REMOVE', `Remove ${skill.name}`, view.busy, view.onRemove, 'skill-row__remove'),
  );
  return actions;
}

function rowButton(label, title, busy, onClick, className = 'skill-row__button') {
  const button = document.createElement('button');
  button.className = className;
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.disabled = busy;
  button.addEventListener('click', onClick);
  return button;
}

function invokeField(param, value, onChange) {
  const field = document.createElement('label');
  field.className = 'skill-field';
  const label = document.createElement('span');
  label.className = 'entry-label';
  label.textContent = `${param.name.toUpperCase()}${param.required ? ' *' : ''}`;
  field.append(label, invokeControl(param, value, onChange));
  return field;
}

function invokeControl(param, value, onChange) {
  if (param.type === 'bool') {
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'skill-field__bool';
    toggle.checked = value === 'true';
    toggle.addEventListener('change', () => onChange(toggle.checked ? 'true' : 'false'));
    return toggle;
  }
  if (param.type === 'enum') {
    const select = document.createElement('select');
    select.className = 'skill-field__select';
    for (const option of optionsOf(param)) select.add(new globalThis.Option(option, option));
    if (value) select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }
  const input = document.createElement('input');
  input.className = 'skill-field__input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.value = value ?? '';
  input.required = param.required === true;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function tag(text) {
  const span = document.createElement('span');
  span.className = 'skill-tag';
  span.textContent = text;
  return span;
}

function emptyRow(text) {
  const row = document.createElement('p');
  row.className = 'drawer-empty';
  row.textContent = text;
  return row;
}
