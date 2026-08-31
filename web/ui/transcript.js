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
      if (item.streamKind === 'thinking') line.classList.add('stream-line--thinking-block');
      if (item.streamKind === 'tool') line.classList.add('stream-line--tool');
      const number = document.createElement('span');
      number.className = 'stream-line__seq';
      number.textContent = item.cls === 'divider' ? '' : `#${++sequence}`;
      const text = document.createElement('div');
      text.className = 'stream-line__text';
      if (item.streamKind === 'thinking') renderThinking(text, item);
      else if (item.streamKind === 'tool') renderTool(text, item);
      else renderContent(text, item);
      if (item.steering === true && onSteerNow && working && index > lastReplyIndex) {
        appendSteeringAction(text, onSteerNow);
      }
      line.append(number, text);
      streamLines.append(line);
    }
    if (working) {
      const activity = currentActivity(items);
      const line = document.createElement('li');
      line.className = 'stream-line stream-line--thinking';
      line.setAttribute('aria-label', activity);
      const cursor = document.createElement('span');
      cursor.className = 'thinking-cursor';
      cursor.textContent = '▋';
      const text = document.createElement('div');
      text.className = 'stream-line__text';
      text.textContent = activity;
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

function renderThinking(target, item) {
  const details = document.createElement('details');
  details.className = 'thinking-block';
  const summary = document.createElement('summary');
  const elapsed = Number.isFinite(item.thinkingElapsedSeconds) ? item.thinkingElapsedSeconds : 0;
  summary.textContent = `thinking · ${elapsed}s`;
  const body = document.createElement('div');
  body.className = 'thinking-block__body';
  body.textContent = item.text;
  details.append(summary, body);
  target.append(details);
}

function renderTool(target, item) {
  const tool = item.tool && typeof item.tool === 'object' ? item.tool : {};
  const status = tool.status === 'ok' || tool.status === 'err' ? tool.status : 'run';
  const glyph = status === 'ok' ? '✓' : status === 'err' ? '✗' : '⏳';
  const statusNode = document.createElement('span');
  statusNode.className = 'tool-line__status';
  statusNode.dataset.status = status;
  statusNode.setAttribute('aria-label', status === 'run' ? 'running' : status);
  statusNode.textContent = glyph;
  const label = document.createElement('span');
  label.className = 'tool-line__label';
  const name = typeof tool.name === 'string' && tool.name ? tool.name : 'tool';
  const summary = typeof tool.summary === 'string' ? tool.summary : '';
  label.textContent = summary ? `${name} · ${summary}` : name;
  target.classList.add('tool-line');
  target.append(statusNode, label);
  if (typeof tool.ms === 'number' && Number.isFinite(tool.ms)) {
    const duration = document.createElement('span');
    duration.className = 'tool-line__duration';
    duration.textContent = ` · ${formatDuration(tool.ms)}`;
    target.append(duration);
  }
}

function formatDuration(value) {
  const milliseconds = Math.max(0, Math.round(value));
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)}s`;
}

function currentActivity(items) {
  const latest = items.findLast(
    (item) => item.streamKind === 'thinking' || item.streamKind === 'tool',
  );
  if (latest?.streamKind === 'thinking') return 'thinking…';
  if (latest?.streamKind === 'tool' && latest.tool?.status === 'run') {
    const name =
      typeof latest.tool.name === 'string' && latest.tool.name ? latest.tool.name : 'tool';
    return `running ${name}…`;
  }
  return 'agent working…';
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

// The label comes from the caller so a restart that moves the project context can say which one
// it moves to, instead of switching the scope silently behind the owner's back.
function appendRestartAction(target, action) {
  const item = document.createElement('li');
  item.className = 'stream-line stream-line--restart';
  const button = document.createElement('button');
  button.className = 'restart-session';
  button.type = 'button';
  button.textContent = action.label;
  button.addEventListener('click', action.run);
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
