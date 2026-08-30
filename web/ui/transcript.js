/* global document */
import { renderMarkdown } from '../lib/markdown.js';

export function createTranscriptView({ streamLines, streamEmpty, jumpLatest, onSteerNow }) {
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

  // `working` is the ratified mid-turn state, so a steering line after the last agent reply is
  // still queued behind the turn in flight — the only case where "Steer now" makes sense.
  const render = (items, working = false, restartAction) => {
    const shouldFollow = followLatest || isNearBottom(streamLines);
    const previousScrollTop = streamLines.scrollTop;
    streamLines.replaceChildren();
    if (!items.length && !working) {
      streamEmpty.hidden = false;
      streamLines.append(streamEmpty);
      if (restartAction) appendRestartAction(streamLines, restartAction);
      updateJump(jumpLatest, true, Boolean(restartAction));
      return;
    }
    streamEmpty.hidden = true;
    const lastReplyIndex = items.findLastIndex(
      (item) => item.cls === 'agent' || item.cls === 'divider',
    );
    let sequence = 0;
    for (const [index, item] of items.entries()) {
      const line = document.createElement('li');
      line.className = `stream-line stream-line--${item.cls}`;
      if (item.cls === 'divider') line.classList.add('stream-line--divider');
      const number = document.createElement('span');
      number.className = 'stream-line__seq';
      number.textContent = item.cls === 'divider' ? '' : `#${++sequence}`;
      const text = document.createElement('div');
      text.className = 'stream-line__text';
      renderContent(text, item);
      if (item.steering === true && onSteerNow && working && index > lastReplyIndex) {
        appendSteeringAction(text, onSteerNow);
      }
      line.append(number, text);
      streamLines.append(line);
    }
    if (working) {
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
    if (restartAction) appendRestartAction(streamLines, restartAction);
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

function appendRestartAction(target, onRestart) {
  const item = document.createElement('li');
  item.className = 'stream-line stream-line--restart';
  const button = document.createElement('button');
  button.className = 'restart-session';
  button.type = 'button';
  button.textContent = 'Open new session here';
  button.addEventListener('click', onRestart);
  item.append(button);
  target.append(item);
}

// Escalating a queued steering message natively: the harness owns the queue, so the phone just
// presses escape for it rather than keeping a queue of its own.
function appendSteeringAction(target, onSteerNow) {
  const button = document.createElement('button');
  button.className = 'steering-send';
  button.type = 'button';
  button.textContent = 'Steer now';
  button.setAttribute('aria-label', 'Steer now: interrupt the current turn so this message lands');
  button.addEventListener('click', () => {
    button.disabled = true;
    Promise.resolve()
      .then(() => onSteerNow())
      .finally(() => {
        button.disabled = false;
      });
  });
  target.append(button);
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

function updateJump(button, isFollowing, hasItems) {
  button.hidden = isFollowing || !hasItems;
}
