// The composer is a textarea that grows with its content and then scrolls. A phone keyboard eats
// most of the viewport, so a fixed one-line box hides everything the owner already typed — but an
// unbounded box would push the transcript off screen, hence the row cap.
//
// Enter still sends and Shift+Enter now inserts a newline: the old single-line input submitted on
// Enter, so keeping that verb is the difference between a familiar composer and a surprising one.
const MAX_ROWS = 8;

export function createComposer({ input, form }) {
  let metrics;

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
  // An empty composer is one row by definition — its scrollHeight would otherwise size to the
  // wrapped placeholder, so the box would open two lines tall and shrink on the first keystroke.
  // Overflow is decided from the applied geometry, which also covers the CSS max-height clamp.
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
    reset() {
      input.value = '';
      autosize();
    },
  };
}
