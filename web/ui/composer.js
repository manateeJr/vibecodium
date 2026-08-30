// The composer is a textarea that grows with its content and then scrolls. A phone keyboard eats
// most of the viewport, so a fixed one-line box hides everything the owner already typed — but an
// unbounded box would push the transcript off screen, hence the row cap.
//
// Enter still sends and Shift+Enter now inserts a newline: the old single-line input submitted on
// Enter, so keeping that verb is the difference between a familiar composer and a surprising one.
const MAX_ROWS = 8;

export function createComposer({ input, form }) {
  let metrics;
  const attachments = [];
  const shareNotes = [];

  // A share and the ATT picker both stage into this one draft. Keeping the paths outside the
  // textarea matters because replacing the text while writing the prompt must not drop a staged
  // file before OPEN gets a chance to assemble it.
  const stageAttachments = (paths) => {
    const incoming = Array.isArray(paths) ? paths : [];
    const fresh = [
      ...new Set(incoming.map((path) => String(path ?? '').trim()).filter(Boolean)),
    ].filter((path) => !attachments.includes(path));
    if (fresh.length === 0) return;
    attachments.push(...fresh);
    appendAttachments(input, fresh);
  };

  const stageNote = (value) => {
    const note = String(value ?? '').trim();
    if (!note || shareNotes.includes(note)) return;
    shareNotes.push(note);
    const current = input.value.trim();
    input.value = current === '' ? note : `${note}\n${current}`;
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  };

  const getPrompt = () => {
    const current = input.value.trim();
    const lines = current.split('\n');
    const notes = shareNotes.filter((note) => !current.includes(note));
    const missingAttachments = attachments
      .filter((path) => {
        const line = `Attached file: ${path}`;
        return !lines.some(
          (currentLine) => currentLine === line || currentLine.startsWith(`${line} `),
        );
      })
      .map((path) => `Attached file: ${path}`);
    return [...notes, ...(current ? [current] : []), ...missingAttachments].join('\n');
  };

  // scrollHeight excludes the border on a border-box element, so the border is added back before
  // the height is applied — otherwise every composer would sit two pixels short and always scroll.
  const measure = () => {
    if (metrics) return metrics;
    const styles = globalThis.getComputedStyle(input);
    const size = (value) => Number.parseFloat(value) || 0;
    const lineHeight = size(styles.lineHeight) || size(styles.fontSize) * 1.45 || 23;
    const border = size(styles.borderTopWidth) + size(styles.borderBottomWidth);
    const frame = size(styles.paddingTop) + size(styles.paddingBottom) + border;
    metrics = { border, row: lineHeight + frame, max: lineHeight * MAX_ROWS + frame };
    return metrics;
  };

  // Collapse first: scrollHeight only shrinks once the element stops reserving its old height.
  // An empty composer is one row by definition — its scrollHeight would otherwise size two lines
  // tall and shrink on the first keystroke.
  const autosize = () => {
    const { border, row, max } = measure();
    input.style.overflowY = 'hidden';
    input.style.height = 'auto';
    const content = input.value === '' ? row : input.scrollHeight + border;
    input.style.height = `${Math.min(content, max)}px`;
    if (input.scrollHeight > input.clientHeight) input.style.overflowY = 'auto';
  };

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });

  autosize();

  return {
    autosize,
    getPrompt,
    stageAttachments,
    stageNote,
    reset() {
      input.value = '';
      attachments.length = 0;
      shareNotes.length = 0;
      autosize();
    },
  };
}
function appendAttachments(input, paths) {
  const current = input.value.trim();
  const lines = paths.map((path) => `Attached file: ${path}`);
  input.value = [...(current ? [current] : []), ...lines].join('\n');
  // The composer sizes itself from input events; a programmatic write has to announce itself.
  input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
}
