// Brand tokens: the single source for the interface, X cards and generation prompts.
// Rules: docs/brand/BRANDBOOK.md. `tokens.css` next to this package is generated from here
// (`pnpm --filter @maskwars/brand gen`) and a test keeps it and brand/tokens.css in step.

export const color = {
  /** Stage, background. */
  ink: '#06050c',
  /** Panels, sheets. */
  ink2: '#0c0b14',
  /** Text, mark. */
  ice: '#eef1ff',
  /** Secondary text. */
  ice60: 'rgba(238, 241, 255, 0.62)',
  ice38: 'rgba(238, 241, 255, 0.38)',
  /** Lines. */
  line: 'rgba(238, 241, 255, 0.1)',
  /** Left corner, higher rank. */
  ember: '#ff681c',
  /** Right corner. */
  violet: '#9b70ff',
  /** Money and advantage only. */
  money: '#00ec97',
  /** Result only: win, title, CALLED IT. */
  amber: '#ffb23f',
  /** LIVE and refusal only. */
  live: '#ff4b3a',
  /** Dark text on Ember, Violet, Amber. */
  onAccent: '#120a04',
} as const;

export type ColorToken = keyof typeof color;

export const radius = '2px';

/** Font stacks. `--font-hubot` and `--font-mona` are set by the app's font loader. */
export const font = {
  word: 'var(--font-hubot, "Hubot Sans"), system-ui, sans-serif',
  num: 'var(--font-mona, "Mona Sans"), system-ui, sans-serif',
} as const;

/** Type scale in px, desk / phone (BRANDBOOK §4). */
export const scale = {
  number: [72, 34],
  name: [40, 17],
  multiplier: [30, 28],
  button: [15, 13],
  text: [14, 13],
} as const;

/** Motion timings in ms (BRANDBOOK §9). */
export const motion = {
  press: 100,
  reduced: 200,
  bell: 1200,
  bellRing: 700,
  leaderHysteresis: 2500,
  leaderPulse: 320,
  lights: 600,
  line: 3000,
  eyesCycle: 7000,
} as const;

const kebab = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();

/** CSS custom properties, name → value, in a stable order. */
export const cssVars: ReadonlyArray<readonly [string, string]> = [
  ...Object.entries(color).map(([k, v]) => [`--${kebab(k)}`, v] as const),
  ['--radius', radius],
  ['--font-word', font.word],
  ['--font-num', font.num],
];

export function tokensCss(): string {
  const body = cssVars.map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `/* MASK WARS brand tokens. Generated from src/tokens.ts, do not edit. */\n:root {\n${body}\n}\n`;
}
