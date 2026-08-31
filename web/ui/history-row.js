/* global document */

// One row shape for every list of sessions: the History drawer, which is now the session manager,
// and the cold-start home. The title is the session's own name whenever it has one — the drawer
// used to render `kind · label` ("session · omp") for every row, which named the provider and
// never the work — and a session an agent opened is dimmed and tagged rather than hidden.
export function historyRow({
  title,
  project,
  meta,
  status = 'done',
  preview = [],
  sub = false,
  onSelect,
}) {
  const button = document.createElement('button');
  button.className = 'history-item';
  button.type = 'button';
  button.dataset.status = status;
  button.dataset.sub = sub ? 'yes' : 'no';

  const heading = document.createElement('span');
  heading.className = 'history-item__title';
  heading.textContent = title;
  if (sub) {
    const tag = document.createElement('span');
    tag.className = 'history-item__tag';
    tag.textContent = 'sub';
    heading.append(tag);
  }

  const scope = document.createElement('span');
  scope.className = 'history-item__project';
  scope.textContent = project;

  const detail = document.createElement('span');
  detail.className = 'history-item__meta';
  detail.textContent = meta;

  button.append(heading, scope, detail);
  // The preview is what makes a row worth tapping on a cold start: three lines of the transcript
  // say which session this is far better than its name or its provider do.
  for (const line of preview) {
    const previewLine = document.createElement('span');
    previewLine.className = 'history-item__preview';
    previewLine.textContent = line;
    button.append(previewLine);
  }
  button.addEventListener('click', () => onSelect());
  return button;
}
