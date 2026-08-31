/* global document */
import { base64ToBlob, blobToBase64 } from '../lib/base64.js';
import { formatBytes } from '../lib/bytes.js';
import { basename, normalizePath, pathMatches } from '../lib/paths.js';

// Uploads land in the shared folder; the control plane enforces the same ceiling server-side.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function createFilesPanel({
  client,
  elements,
  errorMessage,
  onError,
  note,
  getSessionId,
  onOpen,
  attachPaths,
}) {
  let roots = [];
  let currentDir = '';
  let loading = false;
  let uploading = false;
  let attachSessionId = '';

  const setStatus = (text) => {
    elements.filesStatus.textContent = text;
  };

  const report = (message) => {
    setStatus(message);
    onError(message);
  };

  const load = async (dir) => {
    if (loading) return;
    loading = true;
    setStatus('loading…');
    try {
      const result = await client.filesList(dir ? { dir } : {});
      roots = [...result.scope_roots];
      currentDir = dir;
      render(result.entries);
      setStatus('');
    } catch (error) {
      elements.fileList.replaceChildren(emptyRow(`files unavailable: ${errorMessage(error)}`));
      renderRoots();
      renderBreadcrumb();
      setStatus(`file list failed: ${errorMessage(error)}`);
    } finally {
      loading = false;
    }
  };

  const render = (entries) => {
    renderRoots();
    renderBreadcrumb();
    elements.fileList.replaceChildren();
    const sorted = [...entries].sort(compareEntries);
    if (sorted.length === 0) {
      elements.fileList.append(emptyRow('Empty folder.'));
      return;
    }
    for (const entry of sorted)
      elements.fileList.append(entry.is_dir ? directoryRow(entry) : fileRow(entry));
  };

  const renderRoots = () => {
    elements.fileRoots.replaceChildren();
    for (const root of roots) {
      const chip = document.createElement('button');
      chip.className = 'file-chip';
      chip.type = 'button';
      chip.textContent = basename(root) || root;
      chip.title = root;
      chip.dataset.active = pathMatches(currentDir, root) ? 'yes' : 'no';
      chip.addEventListener('click', () => void load(root));
      elements.fileRoots.append(chip);
    }
  };

  const renderBreadcrumb = () => {
    elements.fileBreadcrumb.replaceChildren();
    const root = deepestRoot(currentDir, roots);
    if (!currentDir || !root) {
      const label = document.createElement('span');
      label.className = 'file-crumb file-crumb--label';
      label.textContent = 'SCOPE ROOTS';
      elements.fileBreadcrumb.append(label);
      return;
    }
    const trail = [{ label: basename(root) || root, path: root }];
    const relative = normalizePath(currentDir).slice(normalizePath(root).length);
    let walked = normalizePath(root);
    for (const segment of relative.split('/').filter(Boolean)) {
      walked = `${walked}/${segment}`;
      trail.push({ label: segment, path: walked });
    }
    for (const [index, crumb] of trail.entries()) {
      if (index > 0) elements.fileBreadcrumb.append(separator());
      elements.fileBreadcrumb.append(crumbButton(crumb, index === trail.length - 1, load));
    }
  };

  const directoryRow = (entry) => {
    const row = document.createElement('button');
    row.className = 'file-row file-row--dir';
    row.type = 'button';
    row.title = entry.path;
    const name = document.createElement('span');
    name.className = 'file-row__name';
    name.textContent = `${entry.name}/`;
    const meta = document.createElement('span');
    meta.className = 'file-row__meta';
    meta.textContent = 'folder';
    row.append(name, meta);
    row.addEventListener('click', () => void load(entry.path));
    return row;
  };

  const fileRow = (entry) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const details = document.createElement('div');
    details.className = 'file-row__details';
    const name = document.createElement('span');
    name.className = 'file-row__name';
    name.textContent = entry.name;
    const meta = document.createElement('span');
    meta.className = 'file-row__meta';
    meta.textContent = formatBytes(entry.size);
    details.append(name, meta);
    const action = document.createElement('button');
    action.className = 'file-row__download';
    action.type = 'button';
    action.textContent = 'GET';
    action.title = `Download ${entry.path}`;
    action.setAttribute('aria-label', `Download ${entry.name}`);
    action.addEventListener('click', () => void download(entry));
    row.append(details, action);
    return row;
  };

  const download = async (entry) => {
    setStatus(`downloading ${entry.name}…`);
    try {
      const result = await client.filesDownload({ path: entry.path });
      saveBlob(base64ToBlob(result.content_base64, result.mime), result.name || entry.name);
      setStatus(`downloaded ${result.name || entry.name} · ${formatBytes(result.size)}`);
    } catch (error) {
      report(`download failed: ${errorMessage(error)}`);
    }
  };

  // Attach copies every pick into the shared session folder, then names them in the next turn.
  // One pick is a list, not a file: the input is `multiple`, so the loop is the contract. A single
  // refusal — an oversized pick, one failed upload — must not cost the operator the other files,
  // hence the per-file try and the count of what was actually staged at the end.
  const stageFiles = async (files) => {
    if (uploading || files.length === 0) return [];
    uploading = true;
    elements.attachButton.disabled = true;
    const staged = [];
    try {
      for (const [index, file] of files.entries()) {
        const progress = files.length > 1 ? ` · ${index + 1}/${files.length}` : '';
        const path = await stageOne(file, progress);
        if (path) staged.push(path);
      }
      if (staged.length > 0) {
        attachPaths(staged);
        const skipped = files.length - staged.length;
        note(
          `attached ${staged.length} file${staged.length === 1 ? '' : 's'}${
            skipped > 0 ? ` · ${skipped} skipped` : ''
          }`,
        );
        elements.composeInput.focus();
      }
    } finally {
      uploading = false;
      elements.attachButton.disabled = false;
      elements.attachInput.value = '';
    }
    return staged;
  };

  const stageOne = async (file, progress) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      note(`${file.name} is ${formatBytes(file.size)} · attachments cap at 200 MB`);
      return '';
    }
    note(`reading ${file.name} · ${formatBytes(file.size)}${progress}…`);
    try {
      const content_base64 = await blobToBase64(file);
      note(`uploading ${file.name} · ${formatBytes(file.size)}${progress}…`);
      const result = await client.filesUpload({
        session_id: sessionIdForUpload(),
        name: file.name,
        content_base64,
        ...(file.type ? { mime: file.type } : {}),
      });
      return result.path;
    } catch (error) {
      const message = `attach failed for ${file.name}: ${errorMessage(error)}`;
      note(message);
      onError(message);
      return '';
    }
  };

  // Both the file picker and a share landing feed the composer's single draft attachment list.
  // The callback also renders the same `Attached file:` lines for both paths.

  const sessionIdForUpload = () => {
    const selected = String(getSessionId() ?? '').trim();
    if (selected) return selected;
    if (!attachSessionId) attachSessionId = freshSessionId();
    return attachSessionId;
  };

  const open = () => {
    elements.filesDrawer.hidden = false;
    onOpen?.();
    void load(currentDir);
  };

  const close = () => {
    elements.filesDrawer.hidden = true;
  };

  elements.filesOpen.addEventListener('click', open);
  elements.filesClose.addEventListener('click', close);
  elements.attachButton.addEventListener('click', () => elements.attachInput.click());
  elements.attachInput.addEventListener('change', () => {
    const files = [...(elements.attachInput.files ?? [])];
    if (files.length > 0) void stageFiles(files);
  });

  return { open, close, attachPaths };
}

function crumbButton(crumb, current, load) {
  const button = document.createElement('button');
  button.className = 'file-crumb';
  button.type = 'button';
  button.textContent = crumb.label;
  button.title = crumb.path;
  button.dataset.current = current ? 'yes' : 'no';
  if (current) button.setAttribute('aria-current', 'true');
  button.addEventListener('click', () => void load(crumb.path));
  return button;
}

function separator() {
  const span = document.createElement('span');
  span.className = 'file-crumb__separator';
  span.textContent = '/';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function emptyRow(text) {
  const row = document.createElement('p');
  row.className = 'drawer-empty';
  row.textContent = text;
  return row;
}

function deepestRoot(dir, roots) {
  return roots
    .filter((root) => pathMatches(dir, root))
    .sort((left, right) => normalizePath(right).length - normalizePath(left).length)[0];
}

function compareEntries(left, right) {
  if (left.is_dir !== right.is_dir) return left.is_dir ? -1 : 1;
  return String(left.name).localeCompare(String(right.name));
}

function saveBlob(blob, name) {
  const url = globalThis.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 10_000);
}

function freshSessionId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `attach-${Date.now().toString(36)}`;
}
