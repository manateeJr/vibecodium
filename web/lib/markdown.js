/* global document */

const INLINE_MARKUP = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__)/g;

export function renderMarkdown(target, source) {
  target.replaceChildren();
  const lines = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      target.append(codeBlock(codeLines.join('\n')));
      continue;
    }
    if (/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
        if (!item || /^\s*\d+[.)]\s+/.test(lines[index]) !== ordered) break;
        const listItem = document.createElement('li');
        appendInline(listItem, item[1]);
        list.append(listItem);
        index += 1;
      }
      target.append(list);
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = document.createElement('p');
    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !/^\s*(?:[-*]|\d+[.)])\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    appendInline(paragraph, paragraphLines.join('\n'));
    target.append(paragraph);
  }
}

function appendInline(target, source) {
  let offset = 0;
  for (const match of source.matchAll(INLINE_MARKUP)) {
    const token = match[0];
    const start = match.index ?? offset;
    if (start > offset) target.append(document.createTextNode(source.slice(offset, start)));
    if (token.startsWith('`')) {
      const inlineCode = document.createElement('code');
      inlineCode.textContent = token.slice(1, -1);
      target.append(inlineCode);
    } else {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      target.append(strong);
    }
    offset = start + token.length;
  }
  if (offset < source.length) target.append(document.createTextNode(source.slice(offset)));
}

function codeBlock(source) {
  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-code';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = source;
  pre.append(code);
  const copy = document.createElement('button');
  copy.className = 'copy-button';
  copy.dataset.copy = 'code';
  copy.type = 'button';
  copy.textContent = 'COPY';
  copy.setAttribute('aria-label', 'Copy code block');
  copy.addEventListener('click', async () => {
    try {
      await globalThis.navigator?.clipboard?.writeText(source);
      copy.textContent = 'COPIED';
    } catch {
      copy.textContent = 'COPY FAILED';
    }
    globalThis.setTimeout(() => {
      copy.textContent = 'COPY';
    }, 1_200);
  });
  wrapper.append(pre, copy);
  return wrapper;
}
