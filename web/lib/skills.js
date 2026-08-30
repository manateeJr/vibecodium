// Skills are parameterized prompt presets: the library is canonical, projects adopt from it.
const PARAM_TYPES = new Set(['text', 'enum', 'bool']);
const PARAM_SOURCES = new Set(['prompt', 'agent']);

export function adoptedIds(adoptions, projectName) {
  const name = String(projectName ?? '').trim();
  if (!name) return [];
  return [...(adoptions?.[name] ?? [])];
}

// Composer presets for the scope: the project's adopted skills, library order preserved.
export function skillPresets(skills, adoptions, projectName) {
  const adopted = new Set(adoptedIds(adoptions, projectName));
  return skills
    .filter((skill) => adopted.has(skill.id))
    .map((skill) => ({
      kind: 'skill',
      id: skill.id,
      label: skill.name || skill.id,
      title: skill.description || skill.name || skill.id,
    }));
}

// Agent-sourced params are filled in by the harness, never by the person tapping the preset.
export function promptParams(def) {
  return (def?.params ?? []).filter((param) => param.source !== 'agent');
}

export function paramDefaults(def) {
  const values = {};
  for (const param of promptParams(def)) {
    if (param.type === 'bool') values[param.name] = param.default === 'true' ? 'true' : 'false';
    else values[param.name] = param.default ?? (param.type === 'enum' ? optionsOf(param)[0] : '');
  }
  return values;
}

export function missingParams(def, values) {
  return promptParams(def)
    .filter((param) => param.required && param.type !== 'bool')
    .filter((param) => !String(values[param.name] ?? '').trim())
    .map((param) => param.name);
}

export function optionsOf(param) {
  return (param?.options ?? []).map((option) => String(option)).filter(Boolean);
}

export function emptyParam(index) {
  return {
    name: `param_${index}`,
    type: 'text',
    required: false,
    default: '',
    options: [],
    source: 'prompt',
  };
}

// The draft round-trip is mandatory, so normalize whatever the agent hands back before editing it.
export function normalizeDef(def, fallbackName = '') {
  return {
    id: String(def?.id ?? '').trim(),
    name: String(def?.name ?? fallbackName).trim(),
    description: String(def?.description ?? '').trim(),
    body: String(def?.body ?? ''),
    params: (def?.params ?? []).map(normalizeParam),
    approval: def?.approval === true,
    builtin: def?.builtin === true,
  };
}

function normalizeParam(param) {
  const type = PARAM_TYPES.has(param?.type) ? param.type : 'text';
  const normalized = {
    name: String(param?.name ?? '').trim(),
    type,
    required: param?.required === true,
    source: PARAM_SOURCES.has(param?.source) ? param.source : 'prompt',
  };
  if (param?.default !== undefined) normalized.default = String(param.default);
  if (type === 'enum') normalized.options = optionsOf(param);
  return normalized;
}
