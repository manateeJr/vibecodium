/* global document */

export function createSessionBar({
  bar,
  presetRow,
  onNew,
  onSelect,
  onStop,
  onPreset,
  onRename,
  onToggleAgents,
}) {
  const state = {
    items: [],
    selectedId: '',
    presets: [],
    stopping: false,
    showAgents: false,
  };
  let presetsOpen = false;
  // Only ever one pill in edit mode, and it clears on the next render that is not the edit itself.
  let renamingId = '';

  const newPill = () => {
    const button = document.createElement('button');
    button.className = 'session-pill session-pill--new';
    button.type = 'button';
    button.dataset.active = state.selectedId === '' ? 'yes' : 'no';
    button.textContent = '+ New';
    button.title = 'Start a new session in this project';
    button.setAttribute('aria-current', String(state.selectedId === ''));
    button.addEventListener('click', () => {
      presetsOpen = false;
      renamingId = '';
      onNew();
    });
    return button;
  };

  const presetsPill = () => {
    const button = document.createElement('button');
    button.className = 'session-pill session-pill--presets';
    button.type = 'button';
    button.textContent = presetsOpen ? 'PRESETS ▴' : 'PRESETS ▾';
    button.title = 'Curated prompts for this project';
    button.setAttribute('aria-expanded', String(presetsOpen));
    button.addEventListener('click', () => {
      presetsOpen = !presetsOpen;
      render();
    });
    return button;
  };

  // Sessions an agent opened are noise on a phone: the bar is the operator's own work by default,
  // and this pill is the only way back to the rest.
  const agentsPill = () => {
    const button = document.createElement('button');
    button.className = 'session-pill session-pill--agents';
    button.type = 'button';
    button.dataset.active = state.showAgents ? 'yes' : 'no';
    button.textContent = state.showAgents ? 'AGENTS ON' : 'AGENTS OFF';
    button.title = state.showAgents
      ? 'Hide sessions opened by agents'
      : 'Show sessions opened by agents';
    button.setAttribute('aria-pressed', String(state.showAgents));
    button.addEventListener('click', () => onToggleAgents(!state.showAgents));
    return button;
  };

  const pillText = (item) =>
    item.label
      ? `${item.status} · ${item.label}`
      : `${item.status} · ${item.provider} · ${item.shortId}`;

  const sessionPill = (item) => {
    const active = item.stream_id === state.selectedId;
    const pill = document.createElement('div');
    pill.className = 'session-pill';
    pill.dataset.active = active ? 'yes' : 'no';
    pill.dataset.status = item.status;
    pill.dataset.external = item.external ? 'yes' : 'no';
    if (item.stream_id === renamingId) {
      pill.append(renameField(item));
      return pill;
    }
    const select = document.createElement('button');
    select.className = 'session-pill__select';
    select.type = 'button';
    select.title = item.external
      ? `external ${item.provider} session · ${item.title || item.cwd || item.stream_id}`
      : item.cwd || item.project || item.stream_id;
    select.setAttribute('aria-current', String(active));
    select.setAttribute(
      'aria-label',
      `${item.external ? 'external ' : ''}${item.status} session · ${item.provider} · ${
        item.label || item.shortId
      }`,
    );
    select.addEventListener('click', () => onSelect(item));
    const dot = document.createElement('span');
    dot.className = 'session-pill__dot';
    dot.dataset.status = item.status;
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'session-pill__text';
    text.textContent = pillText(item);
    select.append(dot, text);
    // External sessions belong to the machine: mark them and never offer a stop control.
    if (item.external) select.append(tag('ext'));
    pill.append(select);
    // Rename and stop ride the active pill only, the way the stop control always has: a phone bar
    // full of per-pill icons is unusable, and the active pill is the one the owner is talking about.
    if (active && !item.external) pill.append(renameControl(item));
    if (active && item.status === 'live' && !item.external) pill.append(stopControl(item));
    return pill;
  };

  const renameControl = (item) => {
    const button = document.createElement('button');
    button.className = 'session-pill__rename';
    button.type = 'button';
    button.textContent = '✎';
    button.title = 'Rename this session';
    button.setAttribute('aria-label', `Rename session ${item.label || item.shortId}`);
    button.addEventListener('click', () => {
      renamingId = item.stream_id;
      render();
    });
    return button;
  };

  const renameField = (item) => {
    const field = document.createElement('input');
    field.className = 'session-pill__rename-field';
    field.type = 'text';
    field.value = item.label || '';
    field.placeholder = item.shortId;
    field.setAttribute('aria-label', `Session label for ${item.shortId}`);
    let settled = false;
    const settle = (label) => {
      if (settled) return;
      settled = true;
      renamingId = '';
      if (label !== undefined && label !== (item.label || '')) onRename(item, label);
      else render();
    };
    // Commit on blur, because on a phone the keyboard closing is the usual way out of a field and
    // discarding the typed label there would be the more expensive mistake. Escape still cancels.
    field.addEventListener('blur', () => settle(field.value.trim()));
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        settle(field.value.trim());
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

  const stopControl = (item) => {
    const stop = document.createElement('button');
    stop.className = 'session-pill__stop';
    stop.type = 'button';
    stop.textContent = '■';
    stop.title = 'Stop this session';
    stop.disabled = state.stopping;
    stop.setAttribute('aria-label', `Stop session ${item.label || item.shortId}`);
    stop.addEventListener('click', () => onStop(item));
    return stop;
  };

  const renderPresets = () => {
    presetRow.replaceChildren();
    const open = presetsOpen && state.selectedId === '' && state.presets.length > 0;
    presetRow.hidden = !open;
    if (!open) return;
    for (const preset of state.presets) {
      const chip = document.createElement('button');
      chip.className = 'preset-chip';
      chip.type = 'button';
      chip.textContent = preset.label;
      chip.title = preset.title ?? preset.prompt ?? preset.label;
      chip.dataset.kind = preset.kind ?? 'action';
      chip.addEventListener('click', () => onPreset(preset));
      presetRow.append(chip);
    }
  };

  const render = () => {
    bar.replaceChildren(newPill());
    if (state.selectedId === '' && state.presets.length > 0) bar.append(presetsPill());
    bar.append(agentsPill());
    for (const item of state.items) bar.append(sessionPill(item));
    renderPresets();
  };

  render();

  return {
    update(next) {
      Object.assign(state, next);
      if (state.selectedId !== '' || state.presets.length === 0) presetsOpen = false;
      // A background session refresh must not yank the rename field out from under the owner.
      if (renamingId && state.items.some((item) => item.stream_id === renamingId)) return;
      renamingId = '';
      render();
    },
  };
}

function tag(text) {
  const span = document.createElement('span');
  span.className = 'session-pill__tag';
  span.textContent = text;
  return span;
}
