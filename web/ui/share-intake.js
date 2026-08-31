import { postCommand } from '../lib/command.js';

// Sharing into Vibecodium from a phone. Both platforms end up in the same place — a page load at
// `/?share=<token>` — but they get there differently:
//
//   Android: the manifest declares a POST share_target at /share-intake. The service worker takes
//            that navigation, forwards the multipart body, and redirects here with the token the
//            control plane handed back.
//   iOS:     no share_target exists, so a Shortcut does the same two steps by hand. The recipe is
//            in the README.
//
// Either way the files are already on disk by the time this runs. The token names the staging
// directory, so the landing only has to say what is there, point the scope at the right project,
// and put the paths in the composer — after which OPEN is the ordinary new-session tap.
const TOKEN_PARAM = 'share';
const ERROR_PARAM = 'share_error';

export function createShareIntake({
  connection,
  elements,
  projectManager,
  attachPaths,
  stageNote,
  onError,
  errorMessage,
}) {
  const url = new globalThis.URL(globalThis.location.href);
  const token = url.searchParams.get(TOKEN_PARAM)?.trim() ?? '';
  const failed = url.searchParams.get(ERROR_PARAM)?.trim() ?? '';

  const say = (text, tone = 'ok') => {
    elements.shareStatus.textContent = text;
    elements.shareStatus.dataset.tone = tone;
    elements.shareStatus.hidden = text === '';
  };

  // The query is consumed the moment it is read. A reload must not re-stage the same token — the
  // files are already named in the composer, and a second pass would name them twice.
  const consumeQuery = () => {
    if (!token && !failed) return;
    url.searchParams.delete(TOKEN_PARAM);
    url.searchParams.delete(ERROR_PARAM);
    globalThis.history?.replaceState?.(null, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const run = async () => {
    consumeQuery();
    if (failed) {
      say('share upload failed before it reached the control plane · share it again', 'bad');
      return;
    }
    if (!token) return;
    say('reading shared files…');
    try {
      apply(await postCommand('files.shared_staged', { token }, connection()));
    } catch (error) {
      const message = `shared files unavailable · ${errorMessage(error)}`;
      say(`${message} · the token may have expired`, 'bad');
      onError(message);
    }
  };

  const apply = (value) => {
    const staged = (Array.isArray(value?.files) ? value.files : []).map(stagedPath).filter(Boolean);
    const note = String(value?.note ?? '').trim();
    if (staged.length === 0 && note === '') {
      say(`share ${token} staged nothing · share it again`, 'bad');
      return;
    }
    // Keep the note and paths in the composer's draft state. The visible textarea is only a view
    // of that state: replacing it while writing a prompt must not make SEND forget the share, and
    // the draft rides the NEXT send whether that starts a new session or continues an existing one.
    if (note !== '') stageNote(note);
    if (staged.length > 0) attachPaths(staged);
    say(`${describe(staged.length, note)} · ${scope(value?.project)} · SEND to start`);
    // No second picker: the landing marks the header's project affordance, which opens the picker
    // in HISTORY. A share that guessed the project wrong is then one tap from right.
    elements.activeProject.dataset.share = 'yes';
  };

  // A share can name a project the machine does not have registered. Saying so is the point: the
  // picker is right there and the operator can retarget before they press OPEN.
  const scope = (project) => {
    const name = String(project ?? '').trim();
    if (name === '') return 'pick a project first';
    projectManager.selectProject(name);
    return projectManager.selectedProject()?.name === name
      ? `project ${name}`
      : `project ${name} is not registered · pick one`;
  };

  return { run, token };
}

function stagedPath(file) {
  return String((typeof file === 'string' ? file : file?.path) ?? '').trim();
}

function describe(count, note) {
  const attachments =
    count === 0 ? 'shared note staged' : `${count} shared file${count === 1 ? '' : 's'} staged`;
  return count > 0 && note !== '' ? `${attachments} with a note` : attachments;
}
