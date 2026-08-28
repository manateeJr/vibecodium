export interface DesignTokens {
  readonly palette: {
    readonly bg: string;
    readonly bg2: string;
    readonly ink: string;
    readonly inkHi: string;
    readonly inkDim: string;
    readonly line: string;
    readonly amber: string;
    readonly bad: string;
    readonly ok: string;
    readonly replay: string;
    readonly placeholder: string;
    readonly focus: string;
  };
  readonly font: {
    readonly mono: string;
    readonly sizeBase: string;
    readonly sizeSmall: string;
    readonly lineHeight: number;
    readonly trackingLabel: string;
    readonly trackingSmall: string;
  };
  /** Unitless pixel values keep the scale reusable in CSS and React Native. */
  readonly space: {
    readonly xs: number;
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly xl: number;
    readonly chromeH: number;
  };
}

export const tokens = {
  palette: {
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
  },
  font: {
    mono: 'ui-monospace, "JetBrains Mono", "Fira Code", "DejaVu Sans Mono", Menlo, Consolas, monospace',
    sizeBase: '13px',
    sizeSmall: '11px',
    lineHeight: 1.45,
    trackingLabel: '0.14em',
    trackingSmall: '0.06em',
  },
  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    chromeH: 34,
  },
} as const satisfies DesignTokens;

export function tokensToCssVars(): string {
  const { palette, font, space } = tokens;
  const variables = [
    ['--bg', palette.bg],
    ['--bg-2', palette.bg2],
    ['--ink', palette.ink],
    ['--ink-hi', palette.inkHi],
    ['--ink-dim', palette.inkDim],
    ['--line', palette.line],
    ['--amber', palette.amber],
    ['--bad', palette.bad],
    ['--ok', palette.ok],
    ['--replay', palette.replay],
    ['--placeholder', palette.placeholder],
    ['--focus', palette.focus],
    ['--mono', font.mono],
    ['--fs-base', font.sizeBase],
    ['--fs-small', font.sizeSmall],
    ['--lh', String(font.lineHeight)],
    ['--track-label', font.trackingLabel],
    ['--track-small', font.trackingSmall],
    ['--chrome-h', `${space.chromeH}px`],
  ];
  return `:root{${variables.map(([name, value]) => `${name}:${value}`).join(';')};}`;
}
