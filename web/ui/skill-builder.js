/* global document */
import { emptyParam, normalizeDef, optionsOf } from '../lib/skills.js';

const PARAM_TYPES = ['text', 'enum', 'bool'];
const PARAM_SOURCES = ['prompt', 'agent'];

// Custom skills are always finished by the agent: the form and the conversation both draft first.
export function createSkillBuilder({ client, elements, errorMessage, onError, onSaved }) {
  let mode = 'form';
  let params = [];
  let draftId = '';
  let reviewed = false;
  let busy = false;

  const setStatus = (text) => {
    elements.skillBuilderStatus.textContent = text;
  };

  const report = (message) => {
    setStatus(message);
    onError(message);
  };

  const updateControls = () => {
    elements.skillDraft.disabled = busy;
    elements.skillSave.disabled = busy || !reviewed;
    elements.skillParamAdd.disabled = busy;
    elements.skillModeForm.setAttribute('aria-pressed', String(mode === 'form'));
    elements.skillModeConversation.setAttribute('aria-pressed', String(mode === 'conversation'));
    const conversational = mode === 'conversation' && !reviewed;
    elements.skillBodyField.hidden = conversational;
    elements.skillParamsShell.hidden = conversational;
    elements.skillConversationField.hidden = !conversational;
    elements.skillDraft.textContent = reviewed ? 'REDRAFT WITH AGENT' : 'COMPLETE WITH AGENT';
  };

  const renderParams = () => {
    elements.skillParamsEditor.replaceChildren();
    if (params.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'drawer-empty';
      empty.textContent = 'No parameters.';
      elements.skillParamsEditor.append(empty);
      return;
    }
    for (const [index, param] of params.entries())
      elements.skillParamsEditor.append(paramRow(param, index, renderParams, remove));
  };

  const remove = (index) => {
    params = params.filter((_, position) => position !== index);
    renderParams();
  };

  const setMode = (next) => {
    mode = next;
    updateControls();
  };

  const seedFor = () => {
    const name = elements.skillName.value.trim();
    const description = elements.skillDescription.value.trim();
    const conversation = elements.skillConversation.value.trim();
    const seed = { name, mode };
    if (mode === 'conversation') {
      if (conversation) seed.conversation = conversation;
      return seed;
    }
    const body = elements.skillBody.value.trim();
    if (body) seed.body = body;
    if (params.length > 0) seed.params = params.map(cleanParam).filter((param) => param.name);
    if (description) seed.conversation = description;
    return seed;
  };

  const draft = async () => {
    const seed = seedFor();
    if (!seed.name) {
      setStatus('a skill name is required');
      return;
    }
    if (mode === 'conversation' && !seed.conversation) {
      setStatus('describe the skill so the agent can draft it');
      return;
    }
    busy = true;
    setStatus('drafting with the agent…');
    updateControls();
    try {
      const result = await client.skillDraft({ seed });
      applyDraft(normalizeDef(result.def, seed.name));
      setStatus('draft ready · review, edit, then save');
    } catch (error) {
      report(`skill draft failed: ${errorMessage(error)}`);
    } finally {
      busy = false;
      updateControls();
    }
  };

  const applyDraft = (def) => {
    draftId = def.id;
    elements.skillName.value = def.name;
    if (def.description) elements.skillDescription.value = def.description;
    elements.skillBody.value = def.body;
    elements.skillApproval.checked = def.approval === true;
    params = def.params.map((param) => ({ ...param, options: optionsOf(param) }));
    reviewed = true;
    mode = 'form';
    renderParams();
  };

  const save = async () => {
    const def = normalizeDef(
      {
        id: draftId,
        name: elements.skillName.value.trim(),
        description: elements.skillDescription.value.trim(),
        body: elements.skillBody.value,
        params: params.map(cleanParam).filter((param) => param.name),
        approval: elements.skillApproval.checked,
        builtin: false,
      },
      '',
    );
    if (!def.name || !def.body.trim()) {
      setStatus('name and instructions are required');
      return;
    }
    busy = true;
    setStatus('saving…');
    updateControls();
    try {
      const result = await client.skillSave({ def });
      close();
      onSaved(result.def);
    } catch (error) {
      report(`skill save failed: ${errorMessage(error)}`);
    } finally {
      busy = false;
      updateControls();
    }
  };

  const open = (existing) => {
    const def = existing ? normalizeDef(existing) : undefined;
    elements.skillBuilder.hidden = false;
    elements.skillName.value = def?.name ?? '';
    elements.skillDescription.value = def?.description ?? '';
    elements.skillBody.value = def?.body ?? '';
    elements.skillConversation.value = '';
    elements.skillApproval.checked = def?.approval === true;
    params = (def?.params ?? []).map((param) => ({ ...param, options: optionsOf(param) }));
    draftId = def?.id ?? '';
    reviewed = false;
    mode = 'form';
    setStatus(def ? 'editing a saved skill · redraft to save changes' : '');
    renderParams();
    updateControls();
    elements.skillName.focus();
  };

  const close = () => {
    elements.skillBuilder.hidden = true;
    setStatus('');
  };

  elements.skillModeForm.addEventListener('click', () => setMode('form'));
  elements.skillModeConversation.addEventListener('click', () => setMode('conversation'));
  elements.skillParamAdd.addEventListener('click', () => {
    params = [...params, emptyParam(params.length + 1)];
    renderParams();
  });
  elements.skillBuilderForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void draft();
  });
  elements.skillSave.addEventListener('click', () => void save());
  elements.skillBuilderCancel.addEventListener('click', close);

  renderParams();
  updateControls();
  return { open, close };
}

function paramRow(param, index, rerender, remove) {
  const row = document.createElement('div');
  row.className = 'skill-param';
  row.append(
    paramName(param, index),
    removeButton(param, index, remove),
    paramSelect(param, index, 'type', PARAM_TYPES, rerender),
    paramSelect(param, index, 'source', PARAM_SOURCES),
    requiredToggle(param, index),
    defaultField(param, index),
  );
  if (param.type === 'enum') row.append(optionsField(param, index));
  return row;
}

function paramName(param, index) {
  const input = labelledInput(`Parameter ${index + 1} name`, param.name, (value) => {
    param.name = value.trim();
  });
  input.className = 'skill-param__name';
  input.placeholder = 'name';
  return input;
}

function removeButton(param, index, remove) {
  const button = document.createElement('button');
  button.className = 'skill-param__remove';
  button.type = 'button';
  button.textContent = 'REMOVE';
  button.setAttribute('aria-label', `Remove parameter ${index + 1}`);
  button.addEventListener('click', () => remove(index));
  return button;
}

function paramSelect(param, index, key, values, rerender) {
  const select = document.createElement('select');
  select.className = 'skill-param__select';
  select.setAttribute('aria-label', `Parameter ${index + 1} ${key}`);
  for (const value of values) select.add(new globalThis.Option(value, value));
  select.value = param[key];
  select.addEventListener('change', () => {
    param[key] = select.value;
    rerender?.();
  });
  return select;
}

function requiredToggle(param, index) {
  const label = document.createElement('label');
  label.className = 'skill-param__required';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = param.required === true;
  input.setAttribute('aria-label', `Parameter ${index + 1} required`);
  input.addEventListener('change', () => {
    param.required = input.checked;
  });
  label.append(input, document.createTextNode('REQUIRED'));
  return label;
}

function defaultField(param, index) {
  const input = labelledInput(`Parameter ${index + 1} default`, param.default ?? '', (value) => {
    param.default = value;
  });
  input.className = 'skill-param__default';
  input.placeholder = 'default';
  return input;
}

function optionsField(param, index) {
  const input = labelledInput(
    `Parameter ${index + 1} options`,
    optionsOf(param).join(', '),
    (value) => {
      param.options = value
        .split(',')
        .map((option) => option.trim())
        .filter(Boolean);
    },
  );
  input.className = 'skill-param__options';
  input.placeholder = 'option a, option b';
  return input;
}

function labelledInput(label, value, onInput) {
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.value = value;
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function cleanParam(param) {
  const cleaned = {
    name: String(param.name ?? '').trim(),
    type: param.type,
    required: param.required === true,
    source: param.source,
  };
  if (param.default !== undefined && param.default !== '') cleaned.default = String(param.default);
  if (param.type === 'enum') cleaned.options = optionsOf(param);
  return cleaned;
}
