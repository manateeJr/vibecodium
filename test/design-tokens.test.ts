import assert from 'node:assert/strict';
import test from 'node:test';
import { tokens, tokensToCssVars } from '../src/design/tokens.js';

test('design tokens expose the shared palette and typography contract', () => {
  assert.deepEqual(tokens.palette, {
    bg: '#020604',
    bg2: '#05100b',
    ink: '#86ffc0',
    inkHi: '#e2fff0',
    inkDim: '#4b8a6b',
    line: '#1c4c34',
    amber: '#ffd28a',
    bad: '#ff9b88',
    ok: '#a8ffd2',
    replay: '#79e6dc',
    placeholder: '#33705a',
    focus: '#d9ffe9',
  });
  for (const value of Object.values(tokens.palette)) assert.match(value, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(tokens.font, {
    mono: 'ui-monospace, "JetBrains Mono", "Fira Code", "DejaVu Sans Mono", Menlo, Consolas, monospace',
    sizeBase: '13px',
    sizeSmall: '11px',
    lineHeight: 1.45,
    trackingLabel: '0.14em',
    trackingSmall: '0.06em',
  });
});

test('design tokens serialize to the browser CSS variable contract', () => {
  const css = tokensToCssVars();
  assert.match(css, /--ink:#86ffc0/);
  assert.match(css, /--bg:#020604/);
  assert.match(css, /--bg-2:#05100b/);
  assert.match(css, /--chrome-h:34px/);
});
