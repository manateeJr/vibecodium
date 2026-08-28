import assert from 'node:assert/strict';
import test from 'node:test';
import { tokens, tokensToCssVars } from '../src/design/tokens.js';

test('design tokens expose the shared palette and typography contract', () => {
  assert.deepEqual(tokens.palette, {
    bg: '#06130d',
    bg2: '#071b12',
    ink: '#86ffc0',
    inkHi: '#e2fff0',
    inkDim: '#4b8a6b',
    line: '#17402c',
    amber: '#ffd28a',
    bad: '#ff9b88',
    ok: '#a8ffd2',
    replay: '#79e6dc',
    placeholder: '#33705a',
    focus: '#d9ffe9',
  });
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
  assert.match(css, /--bg:#06130d/);
  assert.match(css, /--chrome-h:34px/);
});
