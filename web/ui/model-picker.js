import { loadSelectedModel, saveSelectedModel } from '../lib/storage.js';

// A short preset list, not a model catalogue: the harness resolves names fuzzily
// (omp --model=opus), so the phone only has to offer the ones the owner actually reaches for.
// The empty value means "whatever the harness defaults to" and sends no --model at all.
export const MODEL_PRESETS = Object.freeze(['fable', 'opus', 'luna']);

export function createModelPicker({ select, onChange }) {
  select.replaceChildren(new globalThis.Option('default', ''));
  for (const preset of MODEL_PRESETS) select.add(new globalThis.Option(preset, preset));

  let selected = normalize(loadSelectedModel());
  select.value = selected;

  select.addEventListener('change', () => {
    selected = normalize(select.value);
    select.value = selected;
    saveSelectedModel(selected);
    onChange(selected);
  });

  return { selected: () => selected };
}

function normalize(value) {
  return MODEL_PRESETS.includes(value) ? value : '';
}
