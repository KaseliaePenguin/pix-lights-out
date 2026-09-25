/** docs/art/palette.json の色のうち、UI で使うもの */
export const colors = {
  ink: '#11111b',
  base: '#1e1e2e',
  surface: '#313244',
  overlay: '#585b70',
  midGrey: '#7f849c',
  subtext: '#a6adc8',
  text: '#cdd6f4',
  white: '#ffffff',
  red: '#e8322b',
  orange: '#ff8c1a',
  yellow: '#ffd60a',
  green: '#0e9f6e',
  cyan: '#22d3ee',
  blue: '#3b82f6',
  magenta: '#f048b8',
  hudGreen: '#39d353',
  hudPurple: '#a855f7',
} as const;

/** 車番 1〜8 のチーム色 (style-guide.md §3)。添字 0 は未使用 */
export const teamColors: readonly string[] = [
  colors.ink,
  colors.red,
  colors.orange,
  colors.yellow,
  colors.green,
  colors.cyan,
  colors.blue,
  colors.magenta,
  colors.white,
];
