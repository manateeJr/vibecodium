/* global document */
import { renderMarkdown } from '../lib/markdown.js';

export function createTranscriptView({ streamLines, streamEmpty, jumpLatest }) {
  let followLatest = true;
  streamLines.addEventListener('scroll', () => {
    followLatest = isNearBottom(streamLines);
    updateJump(jumpLatest, followLatest, streamLines.childElementCount > 0);
  });
  jumpLatest.addEventListener('click', () => {
    followLatest = true;
    streamLines.scrollTop = streamLines.scrollHeight;
    updateJump(jumpLatest, true, streamLines.childElementCount > 0);
  });

  const render = (items, thinking = false) => {
    const shouldFollow = followLatest || isNearBottom(streamLines);
    const previousScrollTop = streamLines.scrollTop;
    streamLines.replaceChildren();
    if (!items.length && !thinking) {
      streamEmpty.hidden = false;
      streamLines.append(streamEmpty);
      updateJump(jumpLatest, true, false);
      return;
    }
    streamEmpty.hidden = true;
    let sequence = 0;
    for (const item of items) {
      const line = document.createElement('li');
      line.className = `stream-line stream-line--${item.cls}`;
      if (item.cls === 'divider') line.classList.add('stream-line--divider');
      const number = document.createElement('span');
      number.className = 'stream-line__seq';
      number.textContent = item.cls === 'divider' ? '' : `#${++sequence}`;
      const text = document.createElement('div');
      text.className = 'stream-line__text';
      renderContent(text, item);
      line.append(number, text);
      streamLines.append(line);
    }
    if (thinking) {
      const line = document.createElement('li');
      line.className = 'stream-line stream-line--thinking';
      line.setAttribute('aria-label', 'Agent working');
      const cursor = document.createElement('span');
      cursor.className = 'thinking-cursor';
      cursor.textContent = '▋';
      const text = document.createElement('div');
      text.className = 'stream-line__text';
      text.textContent = 'agent working…';
      line.append(cursor, text);
      streamLines.append(line);
    }
    if (shouldFollow) {
      followLatest = true;
      streamLines.scrollTop = streamLines.scrollHeight;
    } else {
      streamLines.scrollTop = previousScrollTop;
    }
    updateJump(jumpLatest, followLatest, true);
  };

  return { render };
}

function renderContent(target, item) {
  if (!item.markdown) {
    target.textContent = item.text;
    return;
  }
  const prefix = item.text.match(/^(.+? agent · )([\s\S]*)$/);
  if (!prefix) {
    renderMarkdown(target, item.text);
    return;
  }
  const label = document.createElement('span');
  label.className = 'stream-line__prefix';
  label.textContent = prefix[1];
  const body = document.createElement('div');
  body.className = 'markdown-body';
  renderMarkdown(body, prefix[2]);
  target.append(label, body);
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

function updateJump(button, isFollowing, hasItems) {
  button.hidden = isFollowing || !hasItems;
}
