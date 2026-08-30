/* global document */
import { createPtySubscription } from '../lib/pty-socket.js';

// The substrate creates its PTY through `abduco -n` with no controlling terminal, so the PC side
// renders at abduco's default 80 columns. The mirror is read-only and never sends a resize, so it
// paints a fixed 80-column canvas (a few rows taller than the PTY, which only leaves slack at the
// bottom) and lets a narrow phone viewport scroll and pinch instead of reflowing anything.
const MIRROR_COLS = 80;
const MIRROR_ROWS = 30;
const SCROLLBACK = 5_000;

const STATUS_LABELS = Object.freeze({
  connecting: 'CONNECTING',
  live: 'LIVE · READ ONLY',
  disconnected: 'DISCONNECTED · RETRYING',
  unavailable: 'UNAVAILABLE',
  error: 'PTY ERROR',
});

/**
 * Read-only live terminal mirror for one session.
 *
 * Deliberately one-way: no onData wiring, no key forwarding, and no resize frame ever leaves the
 * phone. Phone terminal interactivity is an explicit non-goal.
 */
export function createPtyMirror({ connection, terminalTarget, empty, status }) {
  let selectedSessionId = '';
  let visible = false;
  let unsubscribe = null;
  let terminal = null;

  const setStatus = (text) => {
    status.textContent = text;
  };

  const openTerminal = () => {
    // The vendored xterm 5.3.0 UMD bundle copies its exports onto the global object, so the
    // constructor IS globalThis.Terminal — not globalThis.Terminal.Terminal.
    const Terminal = globalThis.Terminal;
    if (typeof Terminal !== 'function') {
      setStatus(STATUS_LABELS.unavailable);
      empty.hidden = false;
      empty.textContent = 'The terminal renderer failed to load.';
      return null;
    }
    const style = globalThis.getComputedStyle?.(document.documentElement);
    const token = (name, fallback) => style?.getPropertyValue(name).trim() || fallback;
    const instance = new Terminal({
      cols: MIRROR_COLS,
      rows: MIRROR_ROWS,
      // Raw PTY bytes already carry CRLF; converting again would double-space every line.
      convertEol: false,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: token('--mono', 'monospace'),
      fontSize: 12,
      scrollback: SCROLLBACK,
      theme: {
        background: token('--bg', '#020604'),
        foreground: token('--ink', '#86ffc0'),
        cursor: token('--ink-dim', '#4b8a6b'),
      },
    });
    instance.open(terminalTarget);
    // Belt and braces alongside disableStdin: swallow keys instead of echoing them anywhere.
    instance.attachCustomKeyEventHandler(() => false);
    terminalTarget.setAttribute('aria-readonly', 'true');
    return instance;
  };

  // Tearing down in one place keeps a rapid toggle from leaving a second socket or terminal behind.
  const teardown = () => {
    unsubscribe?.();
    unsubscribe = null;
    terminal?.dispose();
    terminal = null;
    terminalTarget.replaceChildren();
  };

  const connect = () => {
    teardown();
    if (!visible) return;
    if (!selectedSessionId) {
      setStatus('NO SESSION');
      return;
    }
    terminal = openTerminal();
    if (!terminal) return;
    const instance = terminal;
    const sessionId = selectedSessionId;
    const current = () => visible && selectedSessionId === sessionId && terminal === instance;
    setStatus(STATUS_LABELS.connecting);
    unsubscribe = createPtySubscription({
      ...connection(),
      sessionId,
      onData: (data) => {
        if (current()) instance.write(data);
      },
      onStatus: (nextStatus, detail) => {
        if (!current()) return;
        setStatus(STATUS_LABELS[nextStatus] ?? nextStatus.toUpperCase());
        if (nextStatus === 'disconnected') {
          // The server replays its ring buffer on resubscribe, so the next connect repaints.
          instance.write('\r\n\u001b[33m— mirror disconnected, reconnecting —\u001b[0m\r\n');
        } else if (detail) empty.textContent = detail;
      },
    });
  };

  const selectSession = (sessionId) => {
    const nextSessionId = typeof sessionId === 'string' ? sessionId : '';
    if (selectedSessionId === nextSessionId) return;
    selectedSessionId = nextSessionId;
    terminalTarget.hidden = !selectedSessionId;
    empty.hidden = Boolean(selectedSessionId);
    empty.textContent = 'Select a live session to mirror.';
    if (visible) connect();
    else {
      teardown();
      setStatus(selectedSessionId ? 'READY' : 'NO SESSION');
    }
  };

  const setVisible = (nextVisible) => {
    visible = nextVisible === true;
    if (visible) {
      connect();
      return;
    }
    teardown();
    setStatus(selectedSessionId ? 'PAUSED' : 'NO SESSION');
  };

  return { selectSession, setVisible };
}
