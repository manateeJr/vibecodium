/* global document */

export function createSessionBar({ bar, presetRow, onNew, onSelect, onStop, onPreset }) {
  const state = { items: [], selectedId: '', presets: [], stopping: false };
  let presetsOpen = false;

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

  const sessionPill = (item) => {
    const active = item.stream_id === state.selectedId;
    const pill = document.createElement('div');
    pill.className = 'session-pill';
    pill.dataset.active = active ? 'yes' : 'no';
    pill.dataset.status = item.status;
    const select = document.createElement('button');
    select.className = 'session-pill__select';
    select.type = 'button';
    select.title = item.cwd || item.project || item.stream_id;
    select.setAttribute('aria-current', String(active));
    select.setAttribute(
      'aria-label',
      `${item.status} session · ${item.provider} · ${item.shortId}`,
    );
    select.addEventListener('click', () => onSelect(item));
    const dot = document.createElement('span');
    dot.className = 'session-pill__dot';
    dot.dataset.status = item.status;
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'session-pill__text';
    text.textContent = `${item.status} · ${item.provider} · ${item.shortId}`;
    select.append(dot, text);
    pill.append(select);
    if (active && item.status === 'live') pill.append(stopControl(item));
    return pill;
  };

  const stopControl = (item) => {
    const stop = document.createElement('button');
    stop.className = 'session-pill__stop';
    stop.type = 'button';
    stop.textContent = '■';
    stop.title = 'Stop this session';
    stop.disabled = state.stopping;
    stop.setAttribute('aria-label', `Stop session ${item.shortId}`);
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
      chip.title = preset.prompt;
      chip.addEventListener('click', () => onPreset(preset));
      presetRow.append(chip);
    }
  };

  const render = () => {
    bar.replaceChildren(newPill());
    if (state.selectedId === '' && state.presets.length > 0) bar.append(presetsPill());
    for (const item of state.items) bar.append(sessionPill(item));
    renderPresets();
  };

  render();

  return {
    update(next) {
      Object.assign(state, next);
      if (state.selectedId !== '' || state.presets.length === 0) presetsOpen = false;
      render();
    },
  };
}
